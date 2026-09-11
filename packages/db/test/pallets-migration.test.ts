import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPalletLabelTemplates, PALLET_LABEL_TEMPLATE_NAME } from "@markiro/domain";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** The last migration before 06d; everything below is seeded against it. */
const LAST_LEGACY_INDEX = 129;

describe.skipIf(!databaseUrl)("pallets migration", () => {
  const databaseName = `markiro_pallets_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = "pallets-tenant";
  const otherTenantId = "pallets-other-tenant";
  // One product per conversion case, so each is pinned independently.
  const convertible = randomUUID();
  const noBoxCapacity = randomUUID();
  const noPalletCapacity = randomUUID();
  const belowOneBox = randomUUID();
  const shiftConvertible = randomUUID();

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-pallets-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: LAST_LEGACY_INDEX,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });

    for (const id of [tenantId, otherTenantId]) {
      await pool.query(
        "INSERT INTO organization (id,name,slug,created_at) VALUES ($1,$1,$1,now())",
        [id],
      );
      await pool.query("INSERT INTO org_profiles (tenant_id) VALUES ($1)", [id]);
    }

    // The four conversion cases, seeded with the OLD units-valued column.
    await pool.query(
      `INSERT INTO products (id,tenant_id,gtin14,name,box_capacity,pallet_capacity,status)
       VALUES ($1,$5,'04600682000013','Both set',20,240,'active'),
              ($2,$5,'04600682000020','No box capacity',null,240,'active'),
              ($3,$5,'04600682000037','No pallet capacity',20,null,'active'),
              ($4,$5,'04600682000044','Below one box',50,20,'active')`,
      [convertible, noBoxCapacity, noPalletCapacity, belowOneBox, tenantId],
    );
    await pool.query(
      `INSERT INTO shifts (id,tenant_id,product_id,mode,box_capacity,pallet_capacity,pallets_enabled,number_month_key,number_seq)
       VALUES ($1,$2,$3,'aggregation',20,240,true,'SEP26',1)`,
      [shiftConvertible, tenantId, convertible],
    );

    // Now apply 0130 and 0131.
    await migrate(drizzle(pool), { migrationsFolder });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE "${databaseName}"`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("converts a capacity it can divide", async () => {
    const { rows } = await pool.query(
      "SELECT pallet_box_capacity FROM products WHERE id=$1",
      [convertible],
    );
    // 240 units / 20 per box = 12 boxes.
    expect(rows).toEqual([{ pallet_box_capacity: 12 }]);
  });

  it("nulls a capacity it cannot divide", async () => {
    for (const [id, why] of [
      [noBoxCapacity, "no box capacity to divide by"],
      [noPalletCapacity, "nothing to convert"],
      // 20 units with 50 per box is less than one full box: a units figure
      // left under a "boxes" name would be a wrong value, not a preserved one.
      [belowOneBox, "below one box"],
    ] as const) {
      const { rows } = await pool.query(
        "SELECT pallet_box_capacity FROM products WHERE id=$1",
        [id],
      );
      expect(rows, why).toEqual([{ pallet_box_capacity: null }]);
    }
  });

  it("converts shift capacities by the same rule", async () => {
    const { rows } = await pool.query("SELECT pallet_box_capacity FROM shifts WHERE id=$1", [
      shiftConvertible,
    ]);
    expect(rows).toEqual([{ pallet_box_capacity: 12 }]);
  });

  it("drops the units-valued column once converted", async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name='pallet_capacity' AND table_schema='public'`,
    );
    expect(rows).toEqual([]);
  });

  it("treats two null-terminal pallets of one shift as the same pallet", async () => {
    // NULLS NOT DISTINCT is load-bearing: without it the ingest's ON CONFLICT
    // arbiter never fires for a device that has no notion of a terminal, and
    // every batch inserts another pallet row.
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname='pallets_device_pallet_uq'`,
    );
    expect(String(rows[0]?.def)).toContain("NULLS NOT DISTINCT");
  });

  it("refuses two pallets with one SSCC in one tenant", async () => {
    await pool.query(
      `INSERT INTO pallets (tenant_id,shift_id,terminal_id,device_pallet_id,sscc)
       VALUES ($1,$2,null,'p1','103460068200000004')`,
      [tenantId, shiftConvertible],
    );
    await expect(
      pool.query(
        `INSERT INTO pallets (tenant_id,shift_id,terminal_id,device_pallet_id,sscc)
         VALUES ($1,$2,null,'p2','103460068200000004')`,
        [tenantId, shiftConvertible],
      ),
    ).rejects.toThrow(/pallets_tenant_sscc_uq/);
  });

  it("refuses a pallet exception kind it does not know", async () => {
    const { rows } = await pool.query(
      "SELECT id FROM pallets WHERE tenant_id=$1 AND device_pallet_id='p1'",
      [tenantId],
    );
    const palletId = rows[0]!.id;
    await expect(
      pool.query(
        `INSERT INTO pallet_exceptions (tenant_id,kind,pallet_id,shift_id,reason,occurred_at)
         VALUES ($1,'clear',$2,$3,'х',now())`,
        [tenantId, palletId, shiftConvertible],
      ),
    ).rejects.toThrow(/pallet_exceptions_kind_check/);
  });

  it("requires a reason on every pallet exception", async () => {
    const { rows } = await pool.query(
      "SELECT id FROM pallets WHERE tenant_id=$1 AND device_pallet_id='p1'",
      [tenantId],
    );
    await expect(
      pool.query(
        `INSERT INTO pallet_exceptions (tenant_id,kind,pallet_id,shift_id,reason,occurred_at)
         VALUES ($1,'disassemble',$2,$3,null,now())`,
        [tenantId, rows[0]!.id, shiftConvertible],
      ),
    ).rejects.toThrow(/reason/);
  });

  it("refuses a disaggregation line naming both a box and a pallet", async () => {
    const { rows } = await pool.query(
      "SELECT id FROM pallets WHERE tenant_id=$1 AND device_pallet_id='p1'",
      [tenantId],
    );
    const documentId = randomUUID();
    await pool.query(
      `INSERT INTO disaggregation_documents (id,tenant_id,doc_no,created_by_user_id)
       VALUES ($1,$2,'DSG-26-0001','someone')`,
      [documentId, tenantId],
    );
    const boxId = randomUUID();
    await pool.query(
      `INSERT INTO boxes (id,tenant_id,shift_id,device_box_id) VALUES ($1,$2,$3,'b1')`,
      [boxId, tenantId, shiftConvertible],
    );
    await expect(
      pool.query(
        `INSERT INTO disaggregation_document_lines (tenant_id,document_id,sscc_input,box_id,pallet_id,status)
         VALUES ($1,$2,'00103460068200000004',$3,$4,'ok')`,
        [tenantId, documentId, boxId, rows[0]!.id],
      ),
    ).rejects.toThrow(/disaggregation_document_lines_target_check/);
  });

  it("accepts 'pallet' as a label template purpose", async () => {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM label_templates WHERE tenant_id=$1 AND purpose='pallet'",
      [tenantId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("seeds the stock pallet label for every existing tenant", async () => {
    for (const id of [tenantId, otherTenantId]) {
      const { rows } = await pool.query(
        "SELECT spec FROM label_templates WHERE tenant_id=$1 AND name=$2",
        [id, PALLET_LABEL_TEMPLATE_NAME],
      );
      expect(rows).toHaveLength(1);
      // The inlined migration JSON and the builder must not drift apart.
      expect(rows[0]!.spec).toEqual(buildPalletLabelTemplates()[0]!.spec);
    }
  });

  it("points every existing profile at the seeded pallet default", async () => {
    const { rows } = await pool.query(
      `SELECT p.tenant_id FROM org_profiles p
        JOIN label_templates t ON t.id = p.default_pallet_label_template_id
       WHERE t.name = $1 AND t.purpose = 'pallet'`,
      [PALLET_LABEL_TEMPLATE_NAME],
    );
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([tenantId, otherTenantId].sort());
  });
});
