import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { upgradeSchemaQuery } from "../host/upgrade-schema.mjs";
const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
const { Pool } = require("pg");
const url = process.env.CATALOG_TEST_DATABASE_URL;
test(
  "actual PG17 pre-return fingerprint ignores data/analyze and detects schema, ACL and migration changes",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal(target.port, "33791");
    const admin = new Pool({ connectionString: url });
    const name = `upgrade_schema_${randomUUID().replaceAll("-", "_")}`;
    let created = false,
      pool,
      client;
    try {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      target.pathname = `/${name}`;
      pool = new Pool({ connectionString: target.href });
      client = await pool.connect();
      await client.query(
        "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id integer PRIMARY KEY,hash text NOT NULL); INSERT INTO drizzle.__drizzle_migrations VALUES(1,'fixture'); CREATE TABLE public.upgrade_fixture(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,value text NOT NULL)",
      );
      const observe = async () => {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          return (await client.query(upgradeSchemaQuery)).rows[0].jsonb_build_object;
        } finally {
          await client.query("ROLLBACK");
        }
      };
      const before = await observe();
      assert.match(before.schemaSha256, /^[a-f0-9]{64}$/u);
      assert.equal(before.migrationCount, "1");
      await client.query(
        "INSERT INTO public.upgrade_fixture(value) VALUES('fixture'); ANALYZE public.upgrade_fixture",
      );
      assert.deepEqual(await observe(), before);
      for (const sql of [
        "ALTER TABLE public.upgrade_fixture ADD COLUMN changed integer",
        "GRANT SELECT ON public.upgrade_fixture TO PUBLIC",
        "ALTER SEQUENCE public.upgrade_fixture_id_seq INCREMENT BY 2",
      ]) {
        await client.query("BEGIN");
        try {
          await client.query(sql);
          const changed = (await client.query(upgradeSchemaQuery)).rows[0].jsonb_build_object;
          assert.notEqual(changed.schemaSha256, before.schemaSha256);
          assert.equal(changed.migrationSha256, before.migrationSha256);
        } finally {
          await client.query("ROLLBACK");
        }
        assert.deepEqual(await observe(), before);
      }
      await client.query("INSERT INTO drizzle.__drizzle_migrations VALUES(2,'second fixture')");
      const migrated = await observe();
      assert.equal(migrated.schemaSha256, before.schemaSha256);
      assert.notEqual(migrated.migrationSha256, before.migrationSha256);
      assert.equal(migrated.migrationCount, "2");
    } finally {
      if (client) client.release();
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
