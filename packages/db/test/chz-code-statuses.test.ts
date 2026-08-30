import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/schema.js";
import { chzCodeStatuses, chzCodeStatusCursors } from "../src/schema/chz.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

describe("chz code status schema", () => {
  it("stores the ChZ facts and the refresh bookkeeping, but never the raw code", () => {
    const columns = Object.keys(chzCodeStatuses);
    expect(columns).toEqual(
      expect.arrayContaining([
        "tenantId",
        "codeHash",
        "chzProductGroupCode",
        "status",
        "statusEx",
        "ownerInn",
        "withdrawReason",
        "unknownAttempts",
        "firstSeenAt",
        "checkedAt",
        "nextRefreshAt",
      ]),
    );
    // codes.canonical_raw already holds it; duplicating ~100 bytes per code
    // would enlarge the very thing this store exists to avoid re-reading, and
    // it is what makes a detached `codes` partition stop being polled for free.
    expect(columns).not.toContain("canonicalRaw");
  });

  it("tracks how far the ingest walk has read", () => {
    expect(Object.keys(chzCodeStatusCursors)).toEqual(
      expect.arrayContaining(["tenantId", "lastScannedAt"]),
    );
  });
});

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/**
 * Runtime coverage for 0101: the metadata tests above only prove the Drizzle
 * schema objects look right, which cannot catch the primary key, hash format
 * check or product group foreign key actually being enforced by Postgres.
 * This applies the real migration chain against a scratch database and
 * asserts on their runtime behaviour, following the pattern in
 * chz-export-runs.test.ts.
 */
describe.skipIf(!databaseUrl)("chz code status migration", () => {
  const databaseName = `markiro_chz_code_statuses_migration_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const db = drizzle(pool, { schema });
  let temporaryRoot = "";
  let created = false;

  const tenantId = `chz-code-statuses-migration-${randomUUID()}`;

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-chz-code-statuses-migration-"));
    const migrationsThrough0100 = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: migrationsThrough0100,
      lastIncludedIndex: 100,
    });
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0100 });

    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ($1, 'ChZ code statuses tenant', $2, now())`,
      [tenantId, `${tenantId}-${randomUUID()}`],
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("keeps one status row per code however many times it was scanned", async () => {
    await db.insert(schema.chzCodeStatuses).values({ tenantId, codeHash: HASH_A });
    await expect(
      db.insert(schema.chzCodeStatuses).values({ tenantId, codeHash: HASH_A }),
    ).rejects.toMatchObject({
      // Drizzle names the unnamed composite `primaryKey()` after its columns
      // (`<table>_<col>_<col>_pk`), not Postgres's own `<table>_pkey`
      // default — confirmed against the generated 0101 migration SQL.
      cause: expect.objectContaining({
        message: expect.stringMatching(/chz_code_statuses_tenant_id_code_hash_pk/),
      }),
    });
  });

  it("rejects a code hash that is not 64 hex characters", async () => {
    await expect(
      db.insert(schema.chzCodeStatuses).values({ tenantId, codeHash: "not-a-hash" }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/chz_code_statuses_hash_check/),
      }),
    });
  });

  it("refuses a product group that is not in the dictionary", async () => {
    await expect(
      db
        .insert(schema.chzCodeStatuses)
        .values({ tenantId, codeHash: HASH_B, chzProductGroupCode: 9999 }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/foreign key/i) }),
    });
  });
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
