import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Deliberately separate from DATABASE_URL: this suite creates roles only in its task-owned cluster.
const url = process.env.CATALOG_TEST_DATABASE_URL;
describe.skipIf(!url)("release catalog migration on isolated PostgreSQL", () => {
  const dbName = `catalog_${randomUUID().replaceAll("-", "_")}`;
  const admin = new pg.Pool({ connectionString: url });
  const target = new URL(url ?? "postgres://invalid");
  target.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: target.href });
  let created = false;
  beforeAll(async () => {
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='markiro_app') THEN CREATE ROLE markiro_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF; END $$`,
    );
    await admin.query(`CREATE DATABASE "${dbName}"`);
    created = true;
    await migrate(drizzle(pool), {
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    });
  }, 30000);
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${dbName}"`);
    await admin.end();
  });
  const sha = "a".repeat(64);
  async function fixture(
    version = `1.0.${Math.floor(Math.random() * 100000000)}`,
    product = "standalone",
    channel = "stable",
  ) {
    const epoch = randomUUID(),
      intent = randomUUID(),
      receipt = randomUUID(),
      id = randomUUID();
    await pool.query(
      "INSERT INTO release_catalog_epochs(id,product,channel,enabled) VALUES($1,$2,$3,false)",
      [epoch, product, channel],
    );
    await pool.query(
      "INSERT INTO release_catalog_receipts(id,kind,sha256,ledger_key,ledger_version_id) VALUES($1,'publication',$2,$3,'test-version')",
      [receipt, sha, `_publication-ledger/${receipt}.json`],
    );
    await pool.query(
      "INSERT INTO release_catalog_intents(id,epoch_id,owner_fingerprint,idempotency_key,request_digest,product,channel,version,request,expires_at) VALUES($1,$2,$3,$4,$3,$5,$6,$7,'{}',now()+interval '15 minutes')",
      [intent, epoch, sha, randomUUID(), product, channel, version],
    );
    return {
      epoch,
      intent,
      receipt,
      id,
      product,
      channel,
      version,
      path: `/${product}/${channel}${product === "standalone" ? "" : "/releases"}/${version}/fixture.exe`,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function addPublication(client: pg.PoolClient, f: Fixture) {
    await client.query(
      "INSERT INTO release_catalog_publications(id,intent_id,product,channel,version,request_digest,source_sha,file_count,metadata,receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7,1,'{}',$8)",
      [f.id, f.intent, f.product, f.channel, f.version, sha, "b".repeat(40), f.receipt],
    );
  }
  async function addObject(client: pg.PoolClient, f: Fixture) {
    await client.query(
      "INSERT INTO release_catalog_objects(public_path,publication_id,product,channel,version,name,bucket,key,version_id,sha256,size_bytes,content_type) VALUES($1,$2,$3,$4,$5,'fixture.exe','markiro-releases',$6,'pinned-version',$7,1,'application/octet-stream')",
      [
        f.path,
        f.id,
        f.product,
        f.channel,
        f.version,
        `${f.product}/_uploads/${f.intent}/fixture.exe`,
        sha,
      ],
    );
  }
  async function publish(f: Fixture) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await addPublication(c, f);
      await addObject(c, f);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  it("creates the catalog tables through normal migrations", async () => {
    const r = await pool.query(
      "SELECT to_regclass('public.release_catalog_objects')::text AS table_name",
    );
    expect(r.rows).toEqual([{ table_name: "release_catalog_objects" }]);
  });
  it("does not expose partial sets and refuses a committed incomplete set", async () => {
    const f = await fixture();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await addPublication(c, f);
      expect(
        (await pool.query("SELECT id FROM release_catalog_publications WHERE id=$1", [f.id]))
          .rowCount,
      ).toBe(0);
      await expect(c.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
      await c.query("ROLLBACK");
      expect(
        (await pool.query("SELECT id FROM release_catalog_publications WHERE id=$1", [f.id]))
          .rowCount,
      ).toBe(0);
      await c.query("BEGIN");
      await addPublication(c, f);
      await addObject(c, f);
      await c.query("COMMIT");
      expect(
        (
          await pool.query(
            "SELECT public_path FROM release_catalog_objects WHERE publication_id=$1",
            [f.id],
          )
        ).rows,
      ).toEqual([{ public_path: f.path }]);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
  it("does not permit another file to be added after publication", async () => {
    const f = await fixture();
    await publish(f);
    await expect(
      pool.query(
        "INSERT INTO release_catalog_objects(public_path,publication_id,product,channel,version,name,bucket,key,version_id,sha256,size_bytes,content_type) SELECT replace(public_path,'fixture.exe','extra.exe'),publication_id,product,channel,version,'extra.exe',bucket,key,version_id,sha256,size_bytes,content_type FROM release_catalog_objects WHERE publication_id=$1",
        [f.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("prevents rewrites, deletion and truncation even by an accidental owner query", async () => {
    const f = await fixture();
    await publish(f);
    await expect(
      pool.query(
        "UPDATE release_catalog_objects SET version_id='changed' WHERE publication_id=$1",
        [f.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query("DELETE FROM release_catalog_objects WHERE publication_id=$1", [f.id]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("TRUNCATE release_catalog_objects")).rejects.toMatchObject({
      code: "55000",
    });
    expect(
      (
        await pool.query("SELECT version_id FROM release_catalog_objects WHERE publication_id=$1", [
          f.id,
        ])
      ).rows,
    ).toEqual([{ version_id: "pinned-version" }]);
  });
  it("denies UPDATE DELETE TRUNCATE to runtime on every immutable table", async () => {
    const c = await pool.connect();
    try {
      await c.query("SET ROLE markiro_app");
      for (const name of [
        "publications",
        "objects",
        "reservations",
        "channel_events",
        "receipts",
        "oidc_bindings",
      ]) {
        const table = `release_catalog_${name}`;
        const r = await c.query(
          "SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS insert",
          [table],
        );
        expect(r.rows).toEqual([{ read: true, insert: true }]);
        await expect(c.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
        await expect(c.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({ code: "42501" });
        expect(
          (await c.query("SELECT has_table_privilege(current_user,$1,'UPDATE') AS update", [table]))
            .rows,
        ).toEqual([{ update: false }]);
      }
    } finally {
      await c.query("RESET ROLE");
      c.release();
    }
  });
  it("rejects a channel pointer crossing a product boundary", async () => {
    const f = await fixture();
    await publish(f);
    await expect(
      pool.query(
        "INSERT INTO release_catalog_channels(product,channel,revision,publication_id,readable) VALUES('station','stable',1,$1,true)",
        [f.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await pool.query(
      "INSERT INTO release_catalog_channels(product,channel,revision,publication_id,readable) VALUES($1,'stable',1,$2,true)",
      [f.product, f.id],
    );
  });
  it("reserves identity even after an intent fails or expires", async () => {
    const f = await fixture();
    await pool.query("UPDATE release_catalog_intents SET state='failed' WHERE id=$1", [f.intent]);
    await expect(
      pool.query(
        "INSERT INTO release_catalog_intents(id,epoch_id,owner_fingerprint,idempotency_key,request_digest,product,channel,version,request,expires_at,state,created_at) SELECT $1,epoch_id,owner_fingerprint,$2,request_digest,product,channel,version,request,expires_at,state,created_at FROM release_catalog_intents WHERE id=$3",
        [randomUUID(), randomUUID(), f.intent],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query("DELETE FROM release_catalog_intents WHERE id=$1", [f.intent]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query("UPDATE release_catalog_intents SET request_digest=$1 WHERE id=$2", [
        "c".repeat(64),
        f.intent,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
