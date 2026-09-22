import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { stationDevices } from "../src/schema/platform.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
it("models the separate security revocation revision", () => {
  expect(stationDevices).toHaveProperty("securityRevocationRevision");
});
describe.skipIf(!process.env.DATABASE_URL)("security revocation forward migration", () => {
  const name = `security_revoke_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false,
    temporaryRoot = "",
    before: unknown;
  const id = randomUUID();
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "security-revoke-"));
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: temporaryRoot,
      lastIncludedIndex: 173,
    });
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder: temporaryRoot,
      log: () => undefined,
    });
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('revoke-a','A','revoke-a',now())",
    );
    await pool.query(
      "INSERT INTO station_devices(id,tenant_id,name,revoked_at) VALUES ($1,'revoke-a','Source','2026-09-16T12:00:00Z')",
      [id],
    );
    before = (
      await pool.query("SELECT to_jsonb(d) AS data FROM station_devices d WHERE id=$1", [id])
    ).rows[0].data;
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });
  it("preserves historical revoked facts while allowing a fresh security generation", async () => {
    const upgraded = (
      await pool.query(
        "SELECT to_jsonb(d)-'security_revocation_revision' AS data,security_revocation_revision AS revision FROM station_devices d WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(upgraded).toEqual({ data: before, revision: 0 });
    const bumped = (
      await pool.query(
        "UPDATE station_devices SET security_revocation_revision=security_revocation_revision+1 WHERE id=$1 RETURNING credential_epoch,revoked_at,security_revocation_revision",
        [id],
      )
    ).rows[0];
    expect(bumped).toEqual({
      credential_epoch: 2,
      revoked_at: new Date("2026-09-16T12:00:00Z"),
      security_revocation_revision: 1,
    });
    const unchanged = (
      await pool.query(
        "UPDATE station_devices SET security_revocation_revision=security_revocation_revision WHERE id=$1 RETURNING credential_epoch",
        [id],
      )
    ).rows[0];
    expect(unchanged.credential_epoch).toBe(2);
    for (const update of [
      "credential_epoch=3",
      "security_revocation_revision=0",
      "security_revocation_revision=3",
      "security_revocation_revision=2,revoked_at=null",
    ])
      await expect(
        pool.query(`UPDATE station_devices SET ${update} WHERE id=$1`, [id]),
      ).rejects.toMatchObject({ code: "23514" });
  });
});
