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

/** The last migration before the pallet-export code-count relaxation. */
const LAST_LEGACY_INDEX = 162;

/**
 * Migration 0163 relaxes two CHECK constraints so a per-pallet GIS MT
 * aggregation export -- which names box SSCCs only and carries zero unit
 * codes -- can be recorded as `total_code_count = 0` / `code_count = 0`,
 * while a SHIFT export (which must still carry at least one code) keeps the
 * old guarantee.
 */
describe.skipIf(!databaseUrl)("pallet export code-counts migration", () => {
  const databaseName = `markiro_pallet_export_counts_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = "pallet-export-counts-tenant";
  const productId = randomUUID();
  const shiftId = randomUUID();
  const deviceId = randomUUID();
  const palletId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-pallet-export-counts-migration-"));
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
    await pool.query(
      `INSERT INTO pallets (id,tenant_id,shift_id,terminal_id,device_pallet_id) VALUES ($1,$2,$3,$4,'p1')`,
      [palletId, tenantId, shiftId, deviceId],
    );
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Export user', $2)`, [
      userId,
      `${randomUUID()}@example.invalid`,
    ]);

    await migrate(drizzle(pool), { migrationsFolder });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE "${databaseName}"`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("accepts a zero-code pallet export", async () => {
    await expect(
      pool.query(
        `INSERT INTO shift_exports
           (tenant_id, shift_id, pallet_id, format_id, format_version, created_by_user_id, idempotency_key, total_code_count)
         VALUES ($1, NULL, $2, 'pallet_xml_gismt_aggregation', 1, $3, $4, 0)`,
        [tenantId, palletId, userId, randomUUID()],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("still rejects a zero-code SHIFT export", async () => {
    await expect(
      pool.query(
        `INSERT INTO shift_exports
           (tenant_id, shift_id, pallet_id, format_id, format_version, created_by_user_id, idempotency_key, total_code_count)
         VALUES ($1, $2, NULL, 'shift_txt_flat', 1, $3, $4, 0)`,
        [tenantId, shiftId, userId, randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: "shift_exports_total_code_count_positive" });
  });

  it("rejects a non-zero-code pallet export", async () => {
    // The relaxation is target-aware, not a blanket "anything goes once
    // pallet_id is set": a per-pallet aggregation export names box SSCCs only,
    // so a positive unit-code total there is a bug, not a looser case.
    await expect(
      pool.query(
        `INSERT INTO shift_exports
           (tenant_id, shift_id, pallet_id, format_id, format_version, created_by_user_id, idempotency_key, total_code_count)
         VALUES ($1, NULL, $2, 'pallet_xml_gismt_aggregation', 1, $3, $4, 5)`,
        [tenantId, palletId, userId, randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: "shift_exports_total_code_count_positive" });
  });

  it("still accepts a SHIFT export carrying codes", async () => {
    await expect(
      pool.query(
        `INSERT INTO shift_exports
           (tenant_id, shift_id, pallet_id, format_id, format_version, created_by_user_id, idempotency_key, total_code_count)
         VALUES ($1, $2, NULL, 'shift_txt_flat', 1, $3, $4, 1)`,
        [tenantId, shiftId, userId, randomUUID()],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("accepts a zero-code artifact and rejects a negative one", async () => {
    const [exportRow] = (
      await pool.query<{ id: string }>(
        `INSERT INTO shift_exports
           (tenant_id, shift_id, pallet_id, format_id, format_version, created_by_user_id, idempotency_key, total_code_count)
         VALUES ($1, NULL, $2, 'pallet_xml_gismt_aggregation', 1, $3, $4, 0)
         RETURNING id`,
        [tenantId, palletId, userId, randomUUID()],
      )
    ).rows;
    if (!exportRow) throw new Error("Expected the pallet export row to insert");

    await expect(
      pool.query(
        `INSERT INTO shift_export_artifacts
           (tenant_id, export_id, part_number, physical_line_count, code_count, box_count,
            filename, mime_type, byte_size, sha256, object_key)
         VALUES ($1, $2, 1, 1, 0, 2, 'part-1.xml', 'application/xml; charset=utf-8', 10,
                 repeat('a', 64), 'tenants/t/shift-exports/e/attempt-1/part-1.xml')`,
        [tenantId, exportRow.id],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(
      pool.query(
        `INSERT INTO shift_export_artifacts
           (tenant_id, export_id, part_number, physical_line_count, code_count, box_count,
            filename, mime_type, byte_size, sha256, object_key)
         VALUES ($1, $2, 2, 1, -1, 2, 'part-2.xml', 'application/xml; charset=utf-8', 10,
                 repeat('b', 64), 'tenants/t/shift-exports/e/attempt-1/part-2.xml')`,
        [tenantId, exportRow.id],
      ),
    ).rejects.toMatchObject({ constraint: "shift_export_artifacts_code_count_nonnegative" });
  });
});
