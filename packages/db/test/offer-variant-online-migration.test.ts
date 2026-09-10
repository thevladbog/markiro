import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const migrations = readMigrationFiles({ migrationsFolder });
const variant = migrations[127];
if (!variant) throw new Error("Missing offer variant migration");

describe.skipIf(!databaseUrl)("online offer variant migration", () => {
  const databaseName = `markiro_online_variant_${randomUUID().replaceAll("-", "_")}`;
  const scratch = new URL(databaseUrl ?? "postgres://invalid");
  scratch.pathname = `/${databaseName}`;
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratch.toString() });
  const tenantId = randomUUID();
  const actorId = randomUUID();
  const offerId = randomUUID();
  const documentId = randomUUID();
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const migration of migrations.slice(0, 127)) {
        for (const statement of migration.sql) await client.query(statement);
      }
      await client.query("CREATE SCHEMA drizzle");
      await client.query(
        "CREATE TABLE drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)",
      );
      for (const migration of migrations.slice(0, 127)) {
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)",
          [migration.hash, migration.folderMillis],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ($1,'Online fixture',$1,now())",
      [tenantId],
    );
    await pool.query(
      "INSERT INTO platform_users (id,name,email,role,status) VALUES ($1,'Online fixture',$2,'accountant','active')",
      [actorId, `${actorId}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO commercial_offers (id,tenant_id,family_id,revision,total,created_by_platform_user_id) VALUES ($1,$2,$1,5,'100.00',$3)",
      [offerId, tenantId, actorId],
    );
    await pool.query(
      "INSERT INTO commercial_offer_documents (id,tenant_id,offer_id,revision,format,status,object_key,content_type,sha256,byte_size,renderer_version) VALUES ($1,$2,$3,5,'html','ready','legacy/r5.html','text/html',$4,42,'legacy-renderer')",
      [documentId, tenantId, offerId, "a".repeat(64)],
    );
    await pool.query(`
      CREATE TABLE online_migration_evidence (tag text, transaction_id bigint, blocks_writes boolean);
      CREATE TABLE online_migration_fault (enabled boolean);
      INSERT INTO online_migration_fault VALUES (true);
      CREATE FUNCTION record_online_migration() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO online_migration_evidence
        SELECT tg_tag, txid_current(), EXISTS (
          SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid()
          AND relation = 'commercial_offer_documents'::regclass AND granted
          AND mode IN ('AccessExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock')
        );
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'commercial_offer_documents'::regclass
          AND conname = 'commercial_offer_documents_offer_revision_format_uq')
          AND (SELECT enabled FROM online_migration_fault) THEN
          RAISE EXCEPTION 'injected final swap failure';
        END IF;
      END $$;
      CREATE EVENT TRIGGER observe_online_migration ON ddl_command_end
      WHEN TAG IN ('ALTER TABLE', 'CREATE INDEX') EXECUTE FUNCTION record_online_migration();
    `);
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.end();
  });

  it("builds without blocking writers, retains old uniqueness on failure and resumes once", async () => {
    const before = await pool.query("SELECT * FROM commercial_offer_documents WHERE id=$1", [
      documentId,
    ]);
    const run = () =>
      runRuntimeMigrations({ databaseUrl: scratch.toString(), migrationsFolder, log: () => {} });
    await expect(run()).rejects.toThrow();
    const evidence = await pool.query(
      "SELECT * FROM online_migration_evidence WHERE tag = 'CREATE INDEX'",
    );
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({ blocks_writes: false });
    const prepared = await pool.query(
      "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('commercial_offer_documents_offer_revision_format_variant_uq')",
    );
    expect(prepared.rows).toEqual([{ indisvalid: true }]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM pg_constraint WHERE conname = 'commercial_offer_documents_offer_revision_format_uq'",
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query("SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at=$1", [
          variant.folderMillis,
        ])
      ).rowCount,
    ).toBe(0);
    // A failed final transaction reuses the ready index, rather than rebuilding it.
    await expect(run()).rejects.toThrow();
    expect(
      (await pool.query("SELECT 1 FROM online_migration_evidence WHERE tag='CREATE INDEX'"))
        .rowCount,
    ).toBe(1);
    // Reproduce PostgreSQL's INVALID index left by a cancelled concurrent build.
    await pool.query(
      "DROP INDEX CONCURRENTLY commercial_offer_documents_offer_revision_format_variant_uq",
    );
    const writer = await pool.connect();
    const builder = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("LOCK TABLE commercial_offer_documents IN ROW EXCLUSIVE MODE");
      await builder.query("SET statement_timeout='1s'");
      await expect(
        builder.query(`CREATE UNIQUE INDEX CONCURRENTLY commercial_offer_documents_offer_revision_format_variant_uq
        ON commercial_offer_documents (offer_id, revision, format, print_variant)`),
      ).rejects.toMatchObject({ code: "57014" });
    } finally {
      await writer.query("ROLLBACK");
      await builder.query("RESET statement_timeout");
      writer.release();
      builder.release();
    }
    expect(
      (
        await pool.query(
          "SELECT indisvalid FROM pg_index WHERE indexrelid='commercial_offer_documents_offer_revision_format_variant_uq'::regclass",
        )
      ).rows,
    ).toEqual([{ indisvalid: false }]);
    await pool.query("UPDATE online_migration_fault SET enabled=false");
    await run();
    await run();
    expect(
      (await pool.query("SELECT * FROM commercial_offer_documents WHERE id=$1", [documentId])).rows,
    ).toEqual([{ ...before.rows[0], print_variant: "clean" }]);
    const insert =
      "INSERT INTO commercial_offer_documents (tenant_id,offer_id,revision,format,print_variant,renderer_version) VALUES ($1,$2,5,'html',$3,'test')";
    await pool.query(insert, [tenantId, offerId, "signed"]);
    await expect(pool.query(insert, [tenantId, offerId, "signed"])).rejects.toMatchObject({
      code: "23505",
    });
    await expect(pool.query(insert, [tenantId, offerId, "unknown"])).rejects.toMatchObject({
      code: "23514",
    });
    expect(
      (
        await pool.query("SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=$1", [
          variant.folderMillis,
        ])
      ).rows,
    ).toEqual([{ hash: variant.hash }]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM pg_constraint WHERE conname = 'commercial_offer_documents_offer_revision_format_uq'",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT convalidated FROM pg_constraint WHERE conname IN ('commercial_offer_documents_offer_revision_format_variant_uq', 'commercial_offer_documents_print_variant_check')",
        )
      ).rows,
    ).toEqual([{ convalidated: true }, { convalidated: true }]);
    expect(
      (await pool.query("SELECT 1 FROM online_migration_evidence WHERE tag = 'CREATE INDEX'"))
        .rowCount,
    ).toBe(2);
  }, 120_000);
});
