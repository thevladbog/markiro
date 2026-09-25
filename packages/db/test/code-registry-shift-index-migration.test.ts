import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const INDEX_DEFINITION =
  "CREATE INDEX code_registry_tenant_shift_terminal_idx ON public.code_registry USING btree (tenant_id, shift_id, terminal_id)";

describe.skipIf(!databaseUrl)("code registry shift index online migration", () => {
  const name = `markiro_registry_shift_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;
  let temporaryRoot = "";

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-registry-shift-"));
    const legacy = join(temporaryRoot, "legacy");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacy,
      lastIncludedIndex: 174,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${name}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("rebuilds an invalid leftover concurrently and journals migration 0175 once", async () => {
    // A cancelled concurrent build leaves an INVALID index behind.
    const blocker = await pool.connect();
    const builder = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE code_registry IN ROW EXCLUSIVE MODE");
      await builder.query("SET statement_timeout = '1s'");
      await expect(
        builder.query(
          "CREATE INDEX CONCURRENTLY code_registry_tenant_shift_terminal_idx ON public.code_registry (tenant_id, shift_id, terminal_id)",
        ),
      ).rejects.toMatchObject({ code: "57014" });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await builder.query("RESET statement_timeout");
      builder.release();
    }
    const leftover = await pool.query<{ indisvalid: boolean }>(
      "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.code_registry_tenant_shift_terminal_idx')",
    );
    expect(leftover.rows).toEqual([{ indisvalid: false }]);

    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });

    const index = await pool.query<{ indisvalid: boolean; definition: string }>(
      "SELECT indisvalid, pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid = to_regclass('public.code_registry_tenant_shift_terminal_idx')",
    );
    expect(index.rows).toEqual([{ indisvalid: true, definition: INDEX_DEFINITION }]);
    const migration = readMigrationFiles({ migrationsFolder })[175];
    expect(migration).toBeDefined();
    const journal = await pool.query<{ hash: string }>(
      "SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = $1",
      [migration?.hash],
    );
    expect(journal.rows).toHaveLength(1);

    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    const again = await pool.query("SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1", [
      migration?.hash,
    ]);
    expect(again.rowCount).toBe(1);
  }, 180_000);
});
