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

describe.skipIf(!process.env.DATABASE_URL)("shift device entry method migration", () => {
  const name = `markiro_shift_entry_method_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const maintenance = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let temporaryRoot = "";
  let created = false;
  const tenantId = "legacy-entry-method";
  const productId = "11111111-1111-1111-1111-111111111111";
  const shiftId = "22222222-2222-2222-2222-222222222222";
  const deviceId = "33333333-3333-3333-3333-333333333333";

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "shift-entry-method-migration-"));
    const folder = fileURLToPath(new URL("../migrations", import.meta.url));
    const legacy = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: folder,
      targetFolder: legacy,
      lastIncludedIndex: 166,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });

    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ($1,'Legacy','legacy-entry-method',now())",
      [tenantId],
    );
    await pool.query(
      "INSERT INTO products (id, tenant_id, gtin14, name) VALUES ($1,$2,'01234567890128','Legacy product')",
      [productId, tenantId],
    );
    await pool.query(
      "INSERT INTO shifts (id, tenant_id, product_id, mode, number_month_key, number_seq) VALUES ($1,$2,$3,'validation','SEP26',1)",
      [shiftId, tenantId, productId],
    );
    await pool.query(
      "INSERT INTO station_devices (id, tenant_id, name) VALUES ($1,$2,'Legacy station')",
      [deviceId, tenantId],
    );
    // Pre-migration shape: no entry_method column exists yet on this table.
    await pool.query(
      "INSERT INTO shift_device_participants (tenant_id, shift_id, device_id) VALUES ($1,$2,$3)",
      [tenantId, shiftId, deviceId],
    );

    await migrate(drizzle(pool), { migrationsFolder: folder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("defaults a device that entered before this migration to the list entry method", async () => {
    const rows = await pool.query(
      "SELECT entry_method FROM shift_device_participants WHERE tenant_id=$1 AND shift_id=$2 AND device_id=$3",
      [tenantId, shiftId, deviceId],
    );
    expect(rows.rows).toEqual([{ entry_method: "list" }]);
  });

  it("accepts an explicit task_barcode entry method for new rows", async () => {
    const otherDeviceId = "44444444-4444-4444-4444-444444444444";
    await pool.query(
      "INSERT INTO station_devices (id, tenant_id, name) VALUES ($1,$2,'Second station')",
      [otherDeviceId, tenantId],
    );
    await pool.query(
      "INSERT INTO shift_device_participants (tenant_id, shift_id, device_id, entry_method) VALUES ($1,$2,$3,'task_barcode')",
      [tenantId, shiftId, otherDeviceId],
    );

    const rows = await pool.query(
      "SELECT entry_method FROM shift_device_participants WHERE tenant_id=$1 AND shift_id=$2 AND device_id=$3",
      [tenantId, shiftId, otherDeviceId],
    );
    expect(rows.rows).toEqual([{ entry_method: "task_barcode" }]);
  });
});
