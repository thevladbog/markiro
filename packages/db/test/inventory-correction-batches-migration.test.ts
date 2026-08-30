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

describe.skipIf(!databaseUrl)("inventory correction batches migration", () => {
  const databaseName = `markiro_inventory_correction_batches_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = `inventory-corrections-migration-${randomUUID()}`;
  const userId = `inventory-corrections-user-${randomUUID()}`;
  const productId = randomUUID();
  const lineId = randomUUID();
  const deviceId = randomUUID();
  const inventoryId = randomUUID();
  const otherInventoryId = randomUUID();
  const boxId = randomUUID();
  const otherBoxId = randomUUID();
  const legacyCorrectionId = randomUUID();
  const batchId = randomUUID();

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-inventory-correction-batches-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: 103,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });

    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ($1, 'Inventory migration tenant', $2, now())`,
      [tenantId, `${tenantId}-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO "user" (id, name, email)
       VALUES ($1, 'Inventory migration user', $2)`,
      [userId, `${randomUUID()}@example.invalid`],
    );
    await pool.query(
      `INSERT INTO products (id, tenant_id, gtin14, name)
       VALUES ($1, $2, '04600000000015', 'Inventory migration product')`,
      [productId, tenantId],
    );
    await pool.query(
      `INSERT INTO lines (id, tenant_id, name)
       VALUES ($1, $2, 'Inventory migration line')`,
      [lineId, tenantId],
    );
    await pool.query(
      `INSERT INTO station_devices (id, tenant_id, name, line_id)
       VALUES ($1, $2, 'Inventory migration station', $3)`,
      [deviceId, tenantId, lineId],
    );
    await pool.query(
      `INSERT INTO inventories
         (id, tenant_id, number, product_id, gtin14_snapshot, line_id, mode,
          production_date_from, production_date_to, created_by_user_id)
       VALUES
         ($1, $3, 'INV-CORRECTION-LEGACY', $4, '04600000000015', $5, 'check',
          '2026-08-01', '2026-08-31', $6),
         ($2, $3, 'INV-CORRECTION-OTHER', $4, '04600000000015', $5, 'check',
          '2026-08-01', '2026-08-31', $6)`,
      [inventoryId, otherInventoryId, tenantId, productId, lineId, userId],
    );
    await pool.query(
      `INSERT INTO inventory_repack_boxes
         (id, tenant_id, inventory_id, new_sscc, owner_device_id, capacity,
          production_date)
       VALUES
         ($1, $3, $4, '046000000000000015', $5, 20, '2026-08-15'),
         ($2, $3, $6, '046000000000000022', $5, 20, '2026-08-15')`,
      [boxId, otherBoxId, tenantId, inventoryId, deviceId, otherInventoryId],
    );
    await pool.query(
      `INSERT INTO inventory_corrections
         (id, tenant_id, inventory_id, action, reason, request_digest, actor_user_id,
          target_repack_box_id, before_projection_digest, after_projection_digest,
          result_revision, effect_at)
       VALUES ($1, $2, $3, 'invalidate_box', 'Legacy correction', $4, $5, $6, $7, $8, 1, now())`,
      [
        legacyCorrectionId,
        tenantId,
        inventoryId,
        "1".repeat(64),
        userId,
        boxId,
        "2".repeat(64),
        "3".repeat(64),
      ],
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("preserves legacy corrections without inventing a batch", async () => {
    const result = await pool.query<{ batch_id: string | null }>(
      `SELECT batch_id FROM inventory_corrections WHERE id = $1`,
      [legacyCorrectionId],
    );

    expect(result.rows).toEqual([{ batch_id: null }]);
  });

  it("enforces batch ownership by inventory", async () => {
    await pool.query(
      `INSERT INTO inventory_correction_batches
         (id, tenant_id, inventory_id, action, reason, request_digest, actor_user_id,
          selected_event_count, affected_code_count, result_revision)
       VALUES ($1, $2, $3, 'void_scan', 'Bulk correction', $4, $5, 1, 1, 1)`,
      [batchId, tenantId, inventoryId, "4".repeat(64), userId],
    );

    await expect(
      pool.query(
        `INSERT INTO inventory_corrections
           (tenant_id, inventory_id, batch_id, action, reason, request_digest, actor_user_id,
            target_repack_box_id, before_projection_digest, after_projection_digest,
            result_revision, effect_at)
         VALUES ($1, $2, $3, 'void_scan', 'Cross-inventory correction', $4, $5, $6, $7, $8, 1, now())`,
        [
          tenantId,
          otherInventoryId,
          batchId,
          "5".repeat(64),
          userId,
          otherBoxId,
          "6".repeat(64),
          "7".repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ constraint: "inventory_corrections_tenant_batch_fk" });
  });
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
