import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { digest, canonical } from "../backup/schemas.mjs";
import { catalogTables, captureCatalogState, validateCatalogBackup } from "../backup/catalog.mjs";
const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url)),
  { Pool } = require("pg");
const url = process.env.CATALOG_TEST_DATABASE_URL;
test(
  "actual snapshot catalog rows retain original receipt versions despite newer commits",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal(target.port, "33791");
    const admin = new Pool({ connectionString: url }),
      name = `catalog_backup_${randomUUID().replaceAll("-", "_")}`;
    let created = false,
      pool,
      client;
    try {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE catalog_test`);
      created = true;
      target.pathname = `/${name}`;
      pool = new Pool({ connectionString: target.href });
      const id = randomUUID(),
        epoch = randomUUID(),
        receipt = Buffer.from(
          canonical({
            schema: 1,
            id,
            kind: "reservation",
            epoch,
            identity: { product: "handheld", channel: "stable" },
            evidenceSha256: "a".repeat(64),
            entries: [{ kind: "closed" }],
          }),
        );
      const proof = {
        operationId: id,
        sha256: digest(receipt),
        ledgerKey: `_publication-ledger/${id}.json`,
        ledgerVersionId: "original+opaque/version",
      };
      await pool.query(
        "INSERT INTO release_catalog_epochs(id,product,channel,enabled) VALUES($1,'handheld','stable',false)",
        [epoch],
      );
      await pool.query(
        "INSERT INTO release_catalog_receipts(id,kind,sha256,ledger_key,ledger_version_id) VALUES($1,'reservation',$2,$3,$4)",
        [id, proof.sha256, proof.ledgerKey, proof.ledgerVersionId],
      );
      client = await pool.connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT pg_export_snapshot()");
      const tables = [];
      for (const name of catalogTables) {
        const rows = (
          await client.query(`SELECT row_to_json(t)::text AS row FROM ONLY public."${name}" t`)
        ).rows;
        tables.push({
          schema: "public",
          name,
          count: String(rows.length),
          sha256: digest(
            rows
              .map((r) => digest(r.row))
              .sort()
              .map((h) => h + "\n")
              .join(""),
          ),
        });
      }
      await pool.query(
        "INSERT INTO release_catalog_epochs(id,product,channel,enabled) VALUES($1,'handheld','beta',false)",
        [randomUUID()],
      );
      const state = await captureCatalogState(client, { tables });
      assert.equal(state.find((t) => t.name === "release_catalog_epochs").rows.length, 1);
      const journal = [
        [`${id}.json`, receipt],
        [`${id}.stored.json`, Buffer.from(JSON.stringify(proof))],
      ].map(([name, b]) => ({
        name,
        base64: b.toString("base64"),
        sha256: digest(b),
        sizeBytes: b.length,
      }));
      assert.equal(
        validateCatalogBackup({ schema: 1, state, journal }, { tables }).state.length,
        9,
      );
      assert.throws(() =>
        validateCatalogBackup({ schema: 1, state, journal: journal.slice(0, 1) }, { tables }),
      );
      await client.query("COMMIT");
      client.release();
      client = undefined;
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM release_catalog_epochs")).rows[0].n,
        2,
      );
    } finally {
      if (client) {
        await client.query("ROLLBACK");
        client.release();
      }
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
