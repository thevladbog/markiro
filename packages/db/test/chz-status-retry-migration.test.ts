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

describe.skipIf(!databaseUrl)("CHZ status retry migration", () => {
  const databaseName = `markiro_chz_status_retry_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;
  const tenantId = `chz-retry-${randomUUID()}`;

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-chz-status-retry-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: 111,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ($1, 'CHZ retry tenant', $2, now())`,
      [tenantId, `${tenantId}-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO chz_code_statuses
        (tenant_id, code_hash, chz_product_group_code, next_refresh_at)
       VALUES
        ($1, $2, 15, now() + interval '30 days'),
        ($1, $3, 8, now() + interval '30 days')`,
      [tenantId, "a".repeat(64), "b".repeat(64)],
    );
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("requeues beer status rows without disturbing other product groups", async () => {
    const result = await pool.query<{ code: number; due: boolean }>(
      `SELECT chz_product_group_code AS code, next_refresh_at <= now() AS due
       FROM chz_code_statuses
       WHERE tenant_id = $1
       ORDER BY chz_product_group_code`,
      [tenantId],
    );

    expect(result.rows).toEqual([
      { code: 8, due: false },
      { code: 15, due: true },
    ]);
  });
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
