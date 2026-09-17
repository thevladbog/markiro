import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** The last migration before warehouse pallets. */
const LAST_LEGACY_INDEX = 161;

describe.skipIf(!databaseUrl)("warehouse pallets migration", () => {
  const databaseName = `markiro_warehouse_pallets_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = "wh-pallets-tenant";
  const productId = randomUUID();
  const shiftId = randomUUID();
  const deviceId = randomUUID();
  const productionPalletId = randomUUID();

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-wh-pallets-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: LAST_LEGACY_INDEX,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });

    await pool.query("INSERT INTO organization (id,name,slug,created_at) VALUES ($1,$1,$1,now())", [
      tenantId,
    ]);
    await pool.query("INSERT INTO org_profiles (tenant_id) VALUES ($1)", [tenantId]);
    await pool.query(
      `INSERT INTO products (id,tenant_id,gtin14,name,box_capacity,pallet_box_capacity,status)
       VALUES ($1,$2,'04600682000013','Cola',20,12,'active')`,
      [productId, tenantId],
    );
    await pool.query(
      `INSERT INTO shifts (id,tenant_id,product_id,mode,box_capacity,pallet_box_capacity,pallets_enabled,number_month_key,number_seq)
       VALUES ($1,$2,$3,'aggregation',20,12,true,'SEP26',1)`,
      [shiftId, tenantId, productId],
    );
    await pool.query(
      `INSERT INTO station_devices (id,tenant_id,name,kind) VALUES ($1,$2,'TSD-1','handheld')`,
      [deviceId, tenantId],
    );
    // A pre-migration production pallet: must survive as kind='production'.
    await pool.query(
      `INSERT INTO pallets (id,tenant_id,shift_id,terminal_id,device_pallet_id) VALUES ($1,$2,$3,$4,'p1')`,
      [productionPalletId, tenantId, shiftId, deviceId],
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE "${databaseName}"`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("keeps existing pallets as production pallets", async () => {
    const { rows } = await pool.query<{ kind: string; product_id: string | null }>(
      "SELECT kind, product_id FROM pallets WHERE id = $1",
      [productionPalletId],
    );
    expect(rows[0]).toEqual({ kind: "production", product_id: null });
  });

  it("accepts a warehouse pallet with no shift and refuses one without product or device", async () => {
    await pool.query(
      `INSERT INTO pallets (tenant_id,kind,shift_id,terminal_id,device_pallet_id,product_id,device_id)
       VALUES ($1,'warehouse',NULL,$2,'w1',$3,$4)`,
      [tenantId, deviceId, productId, deviceId],
    );
    await expect(
      pool.query(
        `INSERT INTO pallets (tenant_id,kind,shift_id,terminal_id,device_pallet_id,product_id,device_id)
         VALUES ($1,'warehouse',NULL,$2,'w2',NULL,$3)`,
        [tenantId, deviceId, deviceId],
      ),
    ).rejects.toMatchObject({ constraint: "pallets_kind_shape" });
    await expect(
      pool.query(
        `INSERT INTO pallets (tenant_id,kind,shift_id,terminal_id,device_pallet_id)
         VALUES ($1,'production',NULL,$2,'p9')`,
        [tenantId, deviceId],
      ),
    ).rejects.toMatchObject({ constraint: "pallets_kind_shape" });
  });

  it("makes (tenant, device, device_pallet_id) unique for warehouse pallets only", async () => {
    await expect(
      pool.query(
        `INSERT INTO pallets (tenant_id,kind,shift_id,terminal_id,device_pallet_id,product_id,device_id)
         VALUES ($1,'warehouse',NULL,$2,'w1',$3,$4)`,
        [tenantId, deviceId, productId, deviceId],
      ),
    ).rejects.toMatchObject({
      constraint: expect.stringMatching(/^pallets_(warehouse_)?device_pallet_uq$/),
    });
    // The production constraint is unconditional (0162 kept it that way, not
    // scoped to `kind = 'production'`): the already-shipped production-pallet
    // upsert in `pallet-ingest.ts` targets it by column list as its ON
    // CONFLICT arbiter, which only works for a non-partial index/constraint.
    const production = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'pallets_device_pallet_uq'`,
    );
    expect(production.rows[0]?.def).toContain("NULLS NOT DISTINCT");
  });

  it("ties a warehouse pallet's terminal_id to its own device_id", async () => {
    // Same (tenant, device, device_pallet_id) as the existing 'w1' row, but a
    // terminal_id that is NOT this device's own id: pallets_device_pallet_uq
    // (unconditional, keyed on terminal_id/shift_id) would not catch this on
    // its own, so pallets_warehouse_terminal_check must reject it first.
    const otherTerminalId = randomUUID();
    await expect(
      pool.query(
        `INSERT INTO pallets (tenant_id,kind,shift_id,terminal_id,device_pallet_id,product_id,device_id)
         VALUES ($1,'warehouse',NULL,$2,'w1-other-terminal',$3,$4)`,
        [tenantId, otherTerminalId, productId, deviceId],
      ),
    ).rejects.toMatchObject({ constraint: "pallets_warehouse_terminal_check" });

    // A second device building a warehouse pallet with the SAME
    // device_pallet_id, each terminal_id equal to its own device id, must
    // succeed: warehouse identity is scoped per device, not global.
    const otherDeviceId = randomUUID();
    await pool.query(
      `INSERT INTO station_devices (id,tenant_id,name,kind) VALUES ($1,$2,'TSD-2','handheld')`,
      [otherDeviceId, tenantId],
    );
    await pool.query(
      `INSERT INTO pallets (tenant_id,kind,shift_id,terminal_id,device_pallet_id,product_id,device_id)
       VALUES ($1,'warehouse',NULL,$2,'w1',$3,$4)`,
      [tenantId, otherDeviceId, productId, otherDeviceId],
    );
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pallets
        WHERE tenant_id = $1 AND kind = 'warehouse' AND device_pallet_id = 'w1' AND device_id = $2`,
      [tenantId, otherDeviceId],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("creates pallet_membership_rejections with a per-pallet unique sscc", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM pallets WHERE tenant_id = $1 AND kind = 'warehouse'",
      [tenantId],
    );
    const palletId = rows[0]?.id;
    expect(palletId).toBeDefined();
    await pool.query(
      `INSERT INTO pallet_membership_rejections (tenant_id,pallet_id,box_sscc,reason,added_at)
       VALUES ($1,$2,'003460068200000017','not_found',now())`,
      [tenantId, palletId],
    );
    await expect(
      pool.query(
        `INSERT INTO pallet_membership_rejections (tenant_id,pallet_id,box_sscc,reason,added_at)
         VALUES ($1,$2,'003460068200000017','not_found',now())`,
        [tenantId, palletId],
      ),
    ).rejects.toMatchObject({ constraint: "pallet_membership_rejections_tenant_pallet_sscc_uq" });
    await expect(
      pool.query(
        `INSERT INTO pallet_membership_rejections (tenant_id,pallet_id,box_sscc,reason,added_at)
         VALUES ($1,$2,'003460068200000024','accepted',now())`,
        [tenantId, palletId],
      ),
    ).rejects.toMatchObject({ constraint: "pallet_membership_rejections_reason_check" });
    // `pallet_closed` (the target pallet is already closed or disassembled) is
    // part of the accepted set.
    await expect(
      pool.query(
        `INSERT INTO pallet_membership_rejections (tenant_id,pallet_id,box_sscc,reason,added_at)
         VALUES ($1,$2,'003460068200000031','pallet_closed',now())`,
        [tenantId, palletId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("enforces shift_exports_target_shape: exactly one of shift_id / pallet_id", async () => {
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Warehouse pallets export user', $2)`,
      [userId, `${randomUUID()}@example.invalid`],
    );

    await expect(
      pool.query(
        `INSERT INTO shift_exports
           (tenant_id, shift_id, pallet_id, format_id, format_version, created_by_user_id, idempotency_key)
         VALUES ($1, NULL, NULL, 'shift_txt_flat', 1, $2, $3)`,
        [tenantId, userId, randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: "shift_exports_target_shape" });

    await expect(
      pool.query(
        `INSERT INTO shift_exports
           (tenant_id, shift_id, pallet_id, format_id, format_version, created_by_user_id, idempotency_key)
         VALUES ($1, $2, $3, 'shift_txt_flat', 1, $4, $5)`,
        [tenantId, shiftId, productionPalletId, userId, randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: "shift_exports_target_shape" });
  });

  it("lets pallet_exceptions carry no shift and adds the quarantine kind", async () => {
    const { rows } = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'pallet_exceptions' AND column_name = 'shift_id'`,
    );
    expect(rows[0]?.is_nullable).toBe("YES");
    const check = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'station_sync_quarantine_record_kind_check'`,
    );
    expect(check.rows[0]?.def).toContain("'pallet_membership'");
  });

  it("adds can_build_pallets and the pallet export columns", async () => {
    const policy = await pool.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'employee_pickup_policies' AND column_name = 'can_build_pallets'`,
    );
    expect(policy.rows[0]?.column_default).toBe("false");
    const exportCols = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'shift_exports' AND column_name IN ('shift_id','pallet_id') ORDER BY column_name`,
    );
    expect(exportCols.rows).toEqual([
      { column_name: "pallet_id", is_nullable: "YES" },
      { column_name: "shift_id", is_nullable: "YES" },
    ]);
  });
});
