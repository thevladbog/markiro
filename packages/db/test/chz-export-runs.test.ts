import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/schema.js";
import { chzExportRuns } from "../src/schema/chz.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

describe("chz export runs schema", () => {
  it("carries the ChZ identifiers, the actor and the failure detail", () => {
    const columns = Object.keys(chzExportRuns);
    expect(columns).toEqual(
      expect.arrayContaining([
        "tenantId",
        "inventoryId",
        "status",
        "state",
        "dispenserTaskId",
        "resultId",
        "orderedByUserId",
        "importId",
        "errorCode",
        "attempts",
        "claimedAt",
      ]),
    );
  });
});

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Runtime coverage for 0100: the metadata test above only proves the Drizzle
 * schema objects look right, which cannot catch the check constraint
 * accepting or rejecting the wrong states once it is actually enforced by
 * Postgres. This applies the real migration chain against a scratch database
 * and asserts on the constraint's runtime behaviour.
 */
describe.skipIf(!databaseUrl)("chz export runs migration", () => {
  const databaseName = `markiro_chz_export_runs_migration_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const db = drizzle(pool, { schema });
  let temporaryRoot = "";
  let created = false;

  const tenantId = `chz-export-runs-migration-${randomUUID()}`;
  const userId = `chz-export-runs-user-${randomUUID()}`;
  const productId = randomUUID();
  const lineId = randomUUID();
  const inventoryId = randomUUID();
  const importId = randomUUID();

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-chz-export-runs-migration-"));
    const migrationsThrough0099 = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: migrationsThrough0099,
      lastIncludedIndex: 99,
    });
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0099 });

    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ($1, 'ChZ export runs tenant', $2, now())`,
      [tenantId, `${tenantId}-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO "user" (id, name, email)
       VALUES ($1, 'ChZ export runs user', $2)`,
      [userId, `${randomUUID()}@example.invalid`],
    );
    await pool.query(
      `INSERT INTO products (id, tenant_id, gtin14, name)
       VALUES ($1, $2, '04600000000015', 'ChZ export runs product')`,
      [productId, tenantId],
    );
    await pool.query(
      `INSERT INTO lines (id, tenant_id, name)
       VALUES ($1, $2, 'ChZ export runs line')`,
      [lineId, tenantId],
    );
    await pool.query(
      `INSERT INTO inventories
         (id, tenant_id, number, product_id, gtin14_snapshot, line_id, mode,
          production_date_from, production_date_to, created_by_user_id)
       VALUES
         ($1, $2, 'INV-CHZ-EXPORT-RUNS', $3, '04600000000015', $4, 'check',
          '2026-08-01', '2026-08-31', $5)`,
      [inventoryId, tenantId, productId, lineId, userId],
    );
    await pool.query(
      `INSERT INTO inventory_imports
         (id, tenant_id, inventory_id, declared_status, file_name, container_kind,
          byte_size, sha256, object_key, parsed_status, included_gtin14, parse_outcome,
          created_by_user_id)
       VALUES
         ($1, $2, $3, 'EMITTED', 'emitted.csv', 'csv', 100, $4, 'imports/emitted.csv',
          'EMITTED', '04600000000015', 'succeeded', $5)`,
      [importId, tenantId, inventoryId, "0".repeat(64), userId],
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("rejects a run that claims to be ordered with no dispenser task", async () => {
    // drizzle-orm wraps the pg driver error in a DrizzleQueryError whose own
    // `.message` is just "Failed query: ...", the postgres constraint name is
    // on `.cause` — so the assertion has to look there.
    await expect(
      db.insert(schema.chzExportRuns).values({
        tenantId,
        inventoryId,
        status: "EMITTED",
        state: "ordered",
        orderedByUserId: userId,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/chz_export_runs_state_consistency_check/),
      }),
    });
  });

  it("accepts a queued run and the imported terminal state", async () => {
    await db.insert(schema.chzExportRuns).values({
      tenantId,
      inventoryId,
      status: "EMITTED",
      state: "queued",
      orderedByUserId: userId,
    });
    await db
      .update(schema.chzExportRuns)
      .set({ state: "imported", importId, completedAt: new Date() })
      .where(eq(schema.chzExportRuns.tenantId, tenantId));
  });
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
