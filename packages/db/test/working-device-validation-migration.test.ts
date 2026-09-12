import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("working-device constraint validation upgrade", () => {
  const name = `markiro_validation_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  const deviceId = randomUUID();
  let temporaryRoot = "";
  let created = false;

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-validation-"));
    const predecessor = join(temporaryRoot, "predecessor");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: predecessor,
      lastIncludedIndex: 134,
    });
    await migrate(drizzle(pool), { migrationsFolder: predecessor });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('validation','Validation','validation',now())",
    );
    await pool.query(
      "INSERT INTO station_devices (id,tenant_id,name) VALUES ($1,'validation','Source')",
      [deviceId],
    );
    await pool.query(
      `INSERT INTO working_device_events (tenant_id,device_id,actor_domain,action,"after")
       VALUES ('validation',$1,'migration','observed','{}')`,
      [deviceId],
    );
    await pool.query(`
      CREATE TABLE validation_fault (enabled boolean);
      INSERT INTO validation_fault VALUES (true);
      CREATE TABLE validation_evidence (
        statement text, transaction_id bigint, blocks_writes boolean
      );
      CREATE FUNCTION record_working_device_validation() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands()
          WHERE object_identity = 'public.working_device_events') THEN
          INSERT INTO validation_evidence SELECT current_query(), txid_current(), EXISTS (
            SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
            AND relation='working_device_events'::regclass AND granted
            AND mode IN ('AccessExclusiveLock','ShareLock','ShareRowExclusiveLock')
          );
          IF current_query() ILIKE '%VALIDATE CONSTRAINT%'
            AND (SELECT enabled FROM validation_fault) THEN
            RAISE EXCEPTION 'injected validation failure';
          END IF;
        END IF;
      END $$;
      CREATE EVENT TRIGGER observe_working_device_validation ON ddl_command_end
      WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION record_working_device_validation();
    `);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("commits enforced checks before validation, releases writer-blocking locks and resumes", async () => {
    const run = () =>
      runRuntimeMigrations({ databaseUrl: url.toString(), migrationsFolder, log: () => {} });
    const before = (await pool.query("SELECT * FROM working_device_events ORDER BY id")).rows;
    await expect(run()).rejects.toThrow();
    const migrations = readMigrationFiles({ migrationsFolder });
    const preparationMigration = migrations[135];
    const validationMigration = migrations[136];
    expect(preparationMigration).toBeDefined();
    expect(validationMigration).toBeDefined();
    const checks = () =>
      pool.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname,convalidated FROM pg_constraint
       WHERE conrelid='working_device_events'::regclass AND conname IN
       ('working_device_events_action_check','working_device_events_replacement_check')
       ORDER BY conname`,
      );
    expect((await checks()).rows).toEqual([
      { conname: "working_device_events_action_check", convalidated: false },
      { conname: "working_device_events_replacement_check", convalidated: false },
    ]);
    const latest = () =>
      pool.query<{ hash: string }>(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
      );
    expect((await latest()).rows).toEqual([{ hash: preparationMigration?.hash }]);
    // NOT VALID skips old-row scanning, never enforcement for new writes.
    await expect(
      pool.query(
        `INSERT INTO working_device_events (tenant_id,device_id,actor_domain,action,"after")
       VALUES ('validation',$1,'system','unknown','{}')`,
        [deviceId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO working_device_events (tenant_id,device_id,actor_domain,actor_id,action,"after")
       VALUES ('validation',$1,'cabinet','actor','replacement_prepared','{}')`,
        [deviceId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(run()).rejects.toThrow();
    expect((await latest()).rows).toEqual([{ hash: preparationMigration?.hash }]);
    await pool.query("UPDATE validation_fault SET enabled=false");
    await run();
    await run();
    expect((await checks()).rows).toEqual([
      { conname: "working_device_events_action_check", convalidated: true },
      { conname: "working_device_events_replacement_check", convalidated: true },
    ]);
    // The validation migration is no longer the chain's tail — 06d appended
    // two more — so assert the runner journalled it as its own entry and then
    // carried on through the rest of the chain, in order and exactly once.
    const applied = (
      await pool.query<{ hash: string }>(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id",
      )
    ).rows.map((row) => row.hash);
    expect(applied.slice(135)).toEqual(migrations.slice(135).map((migration) => migration.hash));
    expect(applied[136]).toBe(validationMigration?.hash);
    expect((await latest()).rows).toEqual([{ hash: migrations.at(-1)?.hash }]);
    expect((await pool.query("SELECT * FROM working_device_events ORDER BY id")).rows).toEqual(
      before,
    );
    const evidence = (
      await pool.query<{ statement: string; transaction_id: string; blocks_writes: boolean }>(
        "SELECT * FROM validation_evidence",
      )
    ).rows;
    const additions = evidence.filter((row) => row.statement.includes("ADD CONSTRAINT"));
    const validations = evidence.filter((row) => row.statement.includes("VALIDATE CONSTRAINT"));
    expect(additions).toHaveLength(2);
    expect(validations).toHaveLength(2);
    for (const validation of validations) {
      expect(validation.blocks_writes).toBe(false);
      expect(
        additions.every((addition) => addition.transaction_id !== validation.transaction_id),
      ).toBe(true);
    }
  }, 120_000);
});
