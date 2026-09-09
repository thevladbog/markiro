import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chzApiTokens } from "../src/schema/chz.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

it("declares nullable token provenance without a guessed default", () => {
  const column = getTableConfig(chzApiTokens).columns.find(
    (column) => column.name === "source_true_api_base_url",
  );
  expect(column).toMatchObject({ notNull: false, hasDefault: false });
});

describe.skipIf(!process.env.DATABASE_URL)("CHZ token provenance migration", () => {
  const name = `markiro_nc_token_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const maintenance = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let temporaryRoot = "";
  let created = false;
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "nc-token-migration-"));
    const folder = fileURLToPath(new URL("../migrations", import.meta.url));
    const legacy = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: folder,
      targetFolder: legacy,
      lastIncludedIndex: 116,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('legacy-token','Legacy','legacy-token',now())",
    );
    await pool.query(
      "INSERT INTO chz_api_tokens (tenant_id, encrypted_token,token_nonce,token_tag,obtained_at,expires_at) VALUES ('legacy-token',decode('1234','hex'),decode('5678','hex'),decode('90ab','hex'),now(),now()+interval '1 hour')",
    );
    await migrate(drizzle(pool), { migrationsFolder: folder });
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });
  it("retains legacy token bytes and leaves provenance unknown", async () => {
    const rows = await pool.query(
      "SELECT source_true_api_base_url, encode(encrypted_token,'hex') AS encrypted, encode(token_nonce,'hex') AS nonce, encode(token_tag,'hex') AS tag FROM chz_api_tokens WHERE tenant_id='legacy-token'",
    );
    expect(rows.rows).toEqual([
      { source_true_api_base_url: null, encrypted: "1234", nonce: "5678", tag: "90ab" },
    ]);
  });
});
