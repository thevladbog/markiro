import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile, symlink, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";
import { canonical, digest } from "../backup/schemas.mjs";
import {
  captureCatalogState,
  captureCatalogJournal,
  validateCatalogBackup,
  catalogTables,
} from "../backup/catalog.mjs";
const fixture = () => {
  const id = randomUUID(),
    epoch = randomUUID(),
    versionId = "opaque+version/1";
  const receipt = Buffer.from(
    canonical({
      schema: 1,
      id,
      kind: "reservation",
      epoch,
      identity: { product: "handheld", channel: "stable" },
      evidenceSha256: "e".repeat(64),
      entries: [
        { kind: "closed", version: null, publicPath: null, upperBound: null, requestDigest: null },
      ],
    }),
  );
  const proof = {
    operationId: id,
    sha256: digest(receipt),
    ledgerKey: `_publication-ledger/${id}.json`,
    ledgerVersionId: versionId,
  };
  const state = catalogTables.map((name) => ({
    name,
    rows:
      name === "release_catalog_receipts"
        ? [
            JSON.stringify({
              id,
              kind: "reservation",
              sha256: proof.sha256,
              ledger_key: proof.ledgerKey,
              ledger_version_id: versionId,
            }),
          ]
        : name === "release_catalog_epochs"
          ? [JSON.stringify({ id: epoch, product: "handheld", channel: "stable", enabled: false })]
          : [],
  }));
  const inventory = {
    tables: state.map((t) => ({
      schema: "public",
      name: t.name,
      count: String(t.rows.length),
      sha256: digest(
        t.rows
          .map((r) => digest(r))
          .sort()
          .map((h) => h + "\n")
          .join(""),
      ),
    })),
  };
  const journal = [
    {
      name: `${id}.json`,
      sha256: digest(receipt),
      sizeBytes: receipt.length,
      base64: receipt.toString("base64"),
    },
    { name: `${id}.stored.json`, ...file(Buffer.from(JSON.stringify(proof))) },
  ];
  return { id, proof, state, inventory, journal };
};
function file(b) {
  return { sha256: digest(b), sizeBytes: b.length, base64: b.toString("base64") };
}
test("backup contains exact snapshot rows, full local receipts and returned version IDs", async (t) => {
  const f = fixture(),
    fixtureRoot = await privateFixture(t),
    root = join(fixtureRoot.root, "journal");
  await mkdir(root, { mode: 0o700 });
  for (const r of f.journal)
    await writeFile(join(root, r.name), Buffer.from(r.base64, "base64"), { mode: 0o600 });
  const journal = await captureCatalogJournal({ path: root, uid: process.getuid() });
  const bundle = { schema: 1, state: f.state, journal };
  assert.deepEqual(validateCatalogBackup(bundle, f.inventory), bundle);
  assert.equal(
    JSON.parse(Buffer.from(journal.find((r) => r.name.endsWith(".stored.json")).base64, "base64"))
      .ledgerVersionId,
    f.proof.ledgerVersionId,
  );
  assert.throws(() => validateCatalogBackup(undefined, f.inventory));
  for (const change of [
    (b) => b.journal.pop(),
    (b) => b.state[0].rows.push("{}"),
    (b) => (b.journal[0].base64 = "e30="),
    (b) => b.journal.push(b.journal[0]),
    (b) => (b.journal[0].name = "../escape.json"),
    (b) => (b.extra = true),
  ]) {
    const bad = structuredClone(bundle);
    change(bad);
    assert.throws(() => validateCatalogBackup(bad, f.inventory));
  }
});
test("prepared receipt without ack survives backup but is never marked committed", () => {
  const f = fixture();
  f.state = f.state.map((t) => ({ ...t, rows: [] }));
  f.inventory.tables = f.inventory.tables.map((t) => ({ ...t, count: "0", sha256: digest("") }));
  const bundle = {
    schema: 1,
    state: f.state,
    journal: f.journal.filter((r) => !r.name.endsWith(".stored.json")),
  };
  assert.deepEqual(validateCatalogBackup(bundle, f.inventory), bundle);
  assert.throws(() => validateCatalogBackup({ ...bundle, state: f.state.slice(1) }, f.inventory));
});
test("private journal denies symlinks, unsafe permissions, unknown or changed records", async (t) => {
  const f = fixture(),
    fixtureRoot = await privateFixture(t),
    root = join(fixtureRoot.root, "journal");
  await mkdir(root, { mode: 0o700 });
  const target = join(root, f.journal[0].name);
  await writeFile(target, Buffer.from(f.journal[0].base64, "base64"), { mode: 0o600 });
  await chmod(target, 0o644);
  await assert.rejects(captureCatalogJournal({ path: root, uid: process.getuid() }));
  await chmod(target, 0o600);
  await symlink(target, join(root, `${randomUUID()}.json`));
  await assert.rejects(captureCatalogJournal({ path: root, uid: process.getuid() }));
});
test("snapshot capture uses exact raw row bytes and rejects partial catalog schemas", async () => {
  const f = fixture();
  let calls = 0;
  const client = {
    query: async (sql) => {
      calls++;
      const table = f.state.find((t) => sql.includes(`public."${t.name}"`));
      assert.ok(table);
      return sql.includes(" AS bytes ")
        ? { rows: [{ bytes: String(table.rows.reduce((n, r) => n + Buffer.byteLength(r), 0)) }] }
        : { rows: table.rows.map((row) => ({ row })) };
    },
  };
  assert.deepEqual(await captureCatalogState(client, f.inventory), f.state);
  assert.equal(calls, 18);
  await assert.rejects(captureCatalogState(client, { tables: f.inventory.tables.slice(1) }));
  assert.equal(await captureCatalogState(client, { tables: [] }), undefined);
});
