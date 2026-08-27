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

describe.skipIf(!databaseUrl)("inventory document rendering metadata migration", () => {
  const databaseName = `markiro_inventory_document_metadata_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = `inventory-document-migration-${randomUUID()}`;
  const userId = `inventory-document-user-${randomUUID()}`;
  const productId = randomUUID();
  const lineId = randomUUID();
  const reopenedInventoryId = randomUUID();
  const closedInventoryId = randomUUID();
  const reopenedSnapshotId = randomUUID();
  const closedSnapshotId = randomUUID();
  const reopenedRunId = randomUUID();
  const closedRunId = randomUUID();
  const reopenedClosedAt = "2026-08-25T11:12:13.000Z";
  const currentClosedAt = "2026-08-26T14:15:16.000Z";

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-inventory-document-metadata-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: 82,
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
      `INSERT INTO inventories
         (id, tenant_id, number, product_id, gtin14_snapshot, line_id, mode,
          production_date_from, production_date_to, created_by_user_id)
       VALUES
         ($1, $3, 'INV-REOPENED', $4, '04600000000015', $5, 'check',
          '2026-08-01', '2026-08-31', $6),
         ($2, $3, 'INV-CLOSED', $4, '04600000000015', $5, 'check',
          '2026-08-01', '2026-08-31', $6)`,
      [reopenedInventoryId, closedInventoryId, tenantId, productId, lineId, userId],
    );
    await pool.query(
      `INSERT INTO inventory_snapshots
         (id, tenant_id, inventory_id, combined_digest, emitted_count, introduced_count,
          applied_count, retired_count, written_off_count, disaggregation_count,
          protected_count, expected_count, package_count, loose_count, fixed_by_user_id,
          product_name, line_name)
       VALUES
         ($1, $3, $4, $5, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, $6,
          'Inventory migration product', 'Inventory migration line'),
         ($2, $3, $7, $8, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, $6,
          'Inventory migration product', 'Inventory migration line')`,
      [
        reopenedSnapshotId,
        closedSnapshotId,
        tenantId,
        reopenedInventoryId,
        "1".repeat(64),
        userId,
        closedInventoryId,
        "2".repeat(64),
      ],
    );
    await pool.query(
      `UPDATE inventories
       SET status = 'running', active_snapshot_id = $1, station_manifest = '{"snapshotRevision":1}',
           result_revision = 2
       WHERE tenant_id = $2 AND id = $3`,
      [reopenedSnapshotId, tenantId, reopenedInventoryId],
    );
    await pool.query(
      `UPDATE inventories
       SET status = 'closed', active_snapshot_id = $1, station_manifest = '{"snapshotRevision":1}',
           result_revision = 3, closed_by_user_id = $2, closed_at = $3
       WHERE tenant_id = $4 AND id = $5`,
      [closedSnapshotId, userId, currentClosedAt, tenantId, closedInventoryId],
    );
    await pool.query(
      `INSERT INTO inventory_document_runs
         (id, tenant_id, inventory_id, result_revision, selected_formats, request_digest,
          created_by_user_id, idempotency_key, created_at)
       VALUES
         ($1, $3, $4, 1, '[{"id":"inventory_xml_gismt_aggregation","version":1}]', $6, $7, $8,
          '2026-08-27T10:00:00.000Z'),
         ($2, $3, $5, 3, '[{"id":"inventory_xml_gismt_aggregation","version":1}]', $6, $7, $9,
          '2026-08-27T10:01:00.000Z')`,
      [
        reopenedRunId,
        closedRunId,
        tenantId,
        reopenedInventoryId,
        closedInventoryId,
        "a".repeat(64),
        userId,
        randomUUID(),
        randomUUID(),
      ],
    );
    await pool.query(
      `INSERT INTO tenant_audit_events
         (organization_id, actor_user_id, action, outcome, target_type, target_id, before, after)
       VALUES ($1, $2, 'inventory.reopened', 'success', 'inventory', $3, $4, $5)`,
      [
        tenantId,
        userId,
        reopenedInventoryId,
        JSON.stringify({ status: "closed", resultRevision: 1, closedAt: reopenedClosedAt }),
        JSON.stringify({ status: "running", resultRevision: 2, closedAt: null }),
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

  it("recovers reopened runs from the closure audit and preserves current inventory close times", async () => {
    const result = await pool.query<{
      id: string;
      inventory_closed_at_snapshot: Date;
    }>(
      `SELECT id, inventory_closed_at_snapshot
       FROM inventory_document_runs
       WHERE tenant_id = $1
       ORDER BY id`,
      [tenantId],
    );
    const snapshots = new Map(
      result.rows.map((row) => [row.id, row.inventory_closed_at_snapshot.toISOString()]),
    );
    expect(snapshots.get(reopenedRunId)).toBe(reopenedClosedAt);
    expect(snapshots.get(closedRunId)).toBe(currentClosedAt);
  });
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
