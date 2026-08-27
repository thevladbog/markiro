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
const frozenManifestProductName = `Frozen manifest product ${"P".repeat(300)}`;
const frozenManifestLineName = `Frozen manifest line ${"L".repeat(300)}`;

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}

describe.skipIf(!databaseUrl)("inventory snapshot catalog facts migration", () => {
  const databaseName = `markiro_inventory_snapshot_facts_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const db = drizzle(pool);
  let temporaryRoot = "";
  let created = false;

  const tenantId = `snapshot-facts-${randomUUID()}`;
  const userId = `snapshot-facts-user-${randomUUID()}`;
  const productId = randomUUID();
  const lineId = randomUUID();
  const runningInventoryId = randomUUID();
  const readyInventoryId = randomUUID();
  const malformedInventoryId = randomUUID();
  const runningSnapshotId = randomUUID();
  const readySnapshotId = randomUUID();
  const malformedSnapshotId = randomUUID();

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-inventory-snapshot-facts-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: 80,
    });
    await migrate(db, { migrationsFolder: legacyMigrations });

    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())`,
      [tenantId, "Snapshot facts tenant", `${tenantId}-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, false, now(), now())`,
      [userId, "Snapshot facts user", `${randomUUID()}@example.invalid`],
    );
    await pool.query(
      `INSERT INTO products (id, tenant_id, gtin14, name, box_capacity)
       VALUES ($1, $2, '04680089900383', 'Frozen product', 20)`,
      [productId, tenantId],
    );
    await pool.query(`INSERT INTO lines (id, tenant_id, name) VALUES ($1, $2, 'Frozen line')`, [
      lineId,
      tenantId,
    ]);
    for (const inventoryId of [runningInventoryId, readyInventoryId, malformedInventoryId]) {
      await pool.query(
        `INSERT INTO inventories
           (id, tenant_id, number, product_id, gtin14_snapshot, line_id, mode,
            production_date_from, production_date_to, created_by_user_id)
         VALUES ($1, $2, $3, $4, '04680089900383', $5, 'check',
                 '2026-08-01', '2026-08-31', $6)`,
        [inventoryId, tenantId, `INV-${randomUUID()}`, productId, lineId, userId],
      );
    }
    for (const [inventoryId, snapshotId, digest] of [
      [runningInventoryId, runningSnapshotId, "a".repeat(64)],
      [readyInventoryId, readySnapshotId, "b".repeat(64)],
      [malformedInventoryId, malformedSnapshotId, "c".repeat(64)],
    ] as const) {
      await pool.query(
        `INSERT INTO inventory_snapshots
           (id, tenant_id, inventory_id, combined_digest, emitted_count, introduced_count,
            applied_count, retired_count, written_off_count, disaggregation_count,
            protected_count, expected_count, package_count, loose_count, fixed_by_user_id)
         VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $5)`,
        [snapshotId, tenantId, inventoryId, digest, userId],
      );
    }
    await pool.query(
      `UPDATE inventories
          SET status = 'running', active_snapshot_id = $1,
              station_manifest = $2::jsonb, started_by_user_id = $3, started_at = now()
        WHERE tenant_id = $4 AND id = $5`,
      [
        runningSnapshotId,
        `${JSON.stringify({
          productName: frozenManifestProductName,
          lineName: frozenManifestLineName,
        }).slice(0, -1)},"boxCapacity":20.0}`,
        userId,
        tenantId,
        runningInventoryId,
      ],
    );
    await pool.query(
      `UPDATE inventories
          SET status = 'running', active_snapshot_id = $1,
              station_manifest = $2::jsonb, started_by_user_id = $3, started_at = now()
        WHERE tenant_id = $4 AND id = $5`,
      [
        malformedSnapshotId,
        '{"productName":42,"lineName":{"unsafe":true},"boxCapacity":999999999999999999999999999999999999999999999999999999999999}',
        userId,
        tenantId,
        malformedInventoryId,
      ],
    );
    await pool.query(
      `UPDATE inventories SET status = 'ready', active_snapshot_id = $1
        WHERE tenant_id = $2 AND id = $3`,
      [readySnapshotId, tenantId, readyInventoryId],
    );
    await pool.query(
      `UPDATE products SET name = 'Changed catalog product', box_capacity = 24 WHERE id = $1`,
      [productId],
    );
    await pool.query(`UPDATE lines SET name = 'Changed catalog line' WHERE id = $1`, [lineId]);

    await migrate(db, { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("prefers valid running-manifest facts over catalog values changed before migration", async () => {
    await migrate(db, { migrationsFolder });
    const snapshot = await pool.query<{
      product_name: string;
      line_name: string;
      box_capacity: number | null;
    }>(
      `SELECT product_name, line_name, box_capacity
        FROM inventory_snapshots
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runningSnapshotId],
    );
    expect(snapshot.rows).toEqual([
      {
        product_name: frozenManifestProductName,
        line_name: frozenManifestLineName,
        box_capacity: 20,
      },
    ]);
  });

  it("falls back to tenant-scoped catalog facts for ready and malformed-manifest rows", async () => {
    const snapshots = await pool.query<{
      id: string;
      product_name: string;
      line_name: string;
      box_capacity: number | null;
    }>(
      `SELECT id, product_name, line_name, box_capacity
         FROM inventory_snapshots
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id`,
      [tenantId, [readySnapshotId, malformedSnapshotId]],
    );
    expect(snapshots.rows).toEqual(
      expect.arrayContaining([
        {
          id: readySnapshotId,
          product_name: "Changed catalog product",
          line_name: "Changed catalog line",
          box_capacity: 24,
        },
        {
          id: malformedSnapshotId,
          product_name: "Changed catalog product",
          line_name: "Changed catalog line",
          box_capacity: 24,
        },
      ]),
    );
  });

  it("enforces immutable snapshot name columns after backfill", async () => {
    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inventory_snapshots'
          AND column_name IN ('product_name', 'line_name', 'box_capacity')
        ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: "box_capacity", is_nullable: "YES" },
      { column_name: "line_name", is_nullable: "NO" },
      { column_name: "product_name", is_nullable: "NO" },
    ]);
  });
});
