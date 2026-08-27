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

describe.skipIf(!databaseUrl)("inventory document artifact empty-file migration", () => {
  const databaseName = `markiro_inventory_artifact_empty_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = `artifact-empty-${randomUUID()}`;
  const userId = `artifact-empty-user-${randomUUID()}`;
  const productId = randomUUID();
  const lineId = randomUUID();
  const inventoryId = randomUUID();
  const runId = randomUUID();
  const artifactId = randomUUID();

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-inventory-artifact-empty-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: 83,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });

    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ($1, 'Artifact migration tenant', $2, now())`,
      [tenantId, `${tenantId}-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO "user" (id, name, email)
       VALUES ($1, 'Artifact migration user', $2)`,
      [userId, `${randomUUID()}@example.invalid`],
    );
    await pool.query(
      `INSERT INTO products (id, tenant_id, gtin14, name)
       VALUES ($1, $2, '04600000000015', 'Artifact migration product')`,
      [productId, tenantId],
    );
    await pool.query(
      `INSERT INTO lines (id, tenant_id, name)
       VALUES ($1, $2, 'Artifact migration line')`,
      [lineId, tenantId],
    );
    await pool.query(
      `INSERT INTO inventories
         (id, tenant_id, number, product_id, gtin14_snapshot, line_id, mode,
          production_date_from, production_date_to, created_by_user_id)
       VALUES ($1, $2, 'INV-ARTIFACT-EMPTY', $3, '04600000000015', $4, 'check',
               '2026-08-01', '2026-08-31', $5)`,
      [inventoryId, tenantId, productId, lineId, userId],
    );
    await pool.query(
      `INSERT INTO inventory_document_runs
         (id, tenant_id, inventory_id, result_revision, selected_formats, request_digest,
          organization_name_snapshot, inventory_number_snapshot,
          inventory_closed_at_snapshot, created_by_user_id, idempotency_key)
       VALUES ($1, $2, $3, 1, '[{"id":"inventory_txt_write_off","version":1}]', $4,
               'Artifact migration tenant', 'INV-ARTIFACT-EMPTY',
               '2026-08-27T10:00:00.000Z', $5, $6)`,
      [runId, tenantId, inventoryId, "a".repeat(64), userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO inventory_document_artifacts
         (id, tenant_id, run_id, format_id, format_version, part_number, filename, mime_type,
          row_count, code_count, box_count, byte_size, sha256, object_key)
       VALUES ($1, $2, $3, 'inventory_txt_write_off', 1, 1, 'non-empty.txt',
               'text/plain; charset=utf-8', 1, 1, 0, 1, $4, 'artifact/non-empty')`,
      [artifactId, tenantId, runId, "b".repeat(64)],
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("widens only byte_size to accept zero while retaining positive rows and other constraints", async () => {
    await pool.query(`
      CREATE TEMP TABLE artifact_size_probe_before
      (LIKE inventory_document_artifacts INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
    `);
    await expect(
      pool.query(`
        INSERT INTO artifact_size_probe_before
          (id, tenant_id, run_id, format_id, format_version, part_number, filename, mime_type,
           row_count, code_count, box_count, byte_size, sha256, object_key)
        VALUES
          ('00000000-0000-4000-8000-000000000001', 'probe',
           '00000000-0000-4000-8000-000000000002', 'inventory_txt_write_off', 1, 1,
           'empty.txt', 'text/plain; charset=utf-8', 0, 0, 0, 0, repeat('0', 64),
           'probe/empty')
      `),
    ).rejects.toMatchObject({ code: "23514" });

    const before = await inventoryArtifactConstraints(pool);
    expect(before.get("inventory_document_artifacts_byte_size_positive_check")?.definition).toBe(
      "CHECK ((byte_size > 0))",
    );

    await migrate(drizzle(pool), { migrationsFolder });

    const positive = await pool.query<{ byte_size: string }>(
      `SELECT byte_size
         FROM inventory_document_artifacts
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, artifactId],
    );
    expect(positive.rows).toEqual([{ byte_size: "1" }]);

    const after = await inventoryArtifactConstraints(pool);
    const expectedNames = [...before.keys()].filter(
      (name) => name !== "inventory_document_artifacts_byte_size_positive_check",
    );
    expectedNames.push("inventory_document_artifacts_byte_size_nonnegative_check");
    expect([...after.keys()].sort()).toEqual(expectedNames.sort());
    for (const [name, constraint] of before) {
      if (name === "inventory_document_artifacts_byte_size_positive_check") continue;
      expect(after.get(name), `${name} changed unexpectedly`).toEqual(constraint);
    }
    expect(after.get("inventory_document_artifacts_byte_size_nonnegative_check")?.definition).toBe(
      "CHECK ((byte_size >= 0))",
    );

    await pool.query(`
      CREATE TEMP TABLE artifact_size_probe
      (LIKE inventory_document_artifacts INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
    `);
    await pool.query(`
      INSERT INTO artifact_size_probe
        (id, tenant_id, run_id, format_id, format_version, part_number, filename, mime_type,
         row_count, code_count, box_count, byte_size, sha256, object_key)
      VALUES
        ('00000000-0000-4000-8000-000000000001', 'probe',
         '00000000-0000-4000-8000-000000000002', 'inventory_txt_write_off', 1, 1, 'empty.txt',
         'text/plain; charset=utf-8', 0, 0, 0, 0, repeat('0', 64), 'probe/empty')
    `);
    await expect(pool.query(`UPDATE artifact_size_probe SET byte_size = -1`)).rejects.toMatchObject(
      { code: "23514" },
    );
  }, 120_000);
});

type Constraint = { definition: string; type: string };

async function inventoryArtifactConstraints(pool: pg.Pool): Promise<Map<string, Constraint>> {
  const result = await pool.query<{ definition: string; name: string; type: string }>(
    `SELECT constraint_record.conname AS name,
            constraint_record.contype AS type,
            pg_get_constraintdef(constraint_record.oid) AS definition
       FROM pg_constraint AS constraint_record
       JOIN pg_class AS table_record ON table_record.oid = constraint_record.conrelid
       JOIN pg_namespace AS namespace ON namespace.oid = table_record.relnamespace
      WHERE namespace.nspname = current_schema()
        AND table_record.relname = 'inventory_document_artifacts'
      ORDER BY constraint_record.conname`,
  );
  return new Map(
    result.rows.map((row) => [row.name, { definition: row.definition, type: row.type }]),
  );
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
