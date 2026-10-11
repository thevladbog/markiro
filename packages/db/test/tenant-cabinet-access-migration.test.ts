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

describe.skipIf(!databaseUrl)("organization.cabinet_access migration", () => {
  const name = `markiro_cabinet_access_${randomUUID().replaceAll("-", "_")}`;
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
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-cabinet-access-"));
    const legacy = join(temporaryRoot, "legacy");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacy,
      lastIncludedIndex: 175,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ('legacy-org', 'Legacy', 'legacy-org', now())`,
    );
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${name}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("backfills existing tenants as enabled", async () => {
    const { rows } = await pool.query<{ cabinet_access: string }>(
      `SELECT cabinet_access FROM organization WHERE id = 'legacy-org'`,
    );
    expect(rows).toEqual([{ cabinet_access: "enabled" }]);
  });

  it("accepts none and rejects unknown values", async () => {
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at, cabinet_access) VALUES ('offline-org', 'Offline', 'offline-org', now(), 'none')`,
    );
    await expect(
      pool.query(
        `INSERT INTO organization (id, name, slug, created_at, cabinet_access) VALUES ('bad-org', 'Bad', 'bad-org', now(), 'sometimes')`,
      ),
    ).rejects.toThrow(/organization_cabinet_access_ck/);
  });
});
