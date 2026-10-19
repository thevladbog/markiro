/** Invoked only inside backup-ci's disposable, operation-labelled source container. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { captureInventory, compareInventories } from "./inventory.mjs";
import { canonical } from "./schemas.mjs";
// Refuse host/standalone execution before constructing or connecting a PG client.
const [mode, operationId] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.equal(mode, "--local-ci");
assert.equal(process.platform, "linux");
assert.match(operationId, /^[a-f0-9-]{36}$/u);
assert.equal(process.env.MARKIRO_BACKUP_FIXTURE_OPERATION, operationId);
assert.deepEqual(JSON.parse(await readFile("/fixture/operation.json", "utf8")), {
  operationId,
  kind: "disposable-local-backup-fixture",
});
const require = createRequire(import.meta.url),
  { Client } = require("pg");
const client = new Client({
  host: "/var/run/postgresql",
  user: "postgres",
  database: "markiro",
  connectionTimeoutMillis: 15000,
  statement_timeout: 600000,
});
const mutations = [];
for (const [table, column] of [
  ["station_devices", "credential_epoch"],
  ["kiosks", "credential_epoch"],
  ["station_devices", "security_revocation_revision"],
])
  for (const action of ["DROP NOT NULL", "DROP DEFAULT", "SET DEFAULT 17"])
    mutations.push([
      `${table}.${column} ${action}`,
      `ALTER TABLE public.${table} ALTER COLUMN ${column} ${action}`,
    ]);
mutations.push(
  [
    "view query",
    "CREATE OR REPLACE VIEW fixture.visible AS SELECT id + 1 AS id FROM fixture.encrypted",
  ],
  ["enum labels", "ALTER TYPE fixture.state ADD VALUE 'extra' BEFORE 'done'"],
  ["domain NOT NULL", "ALTER DOMAIN fixture.positive DROP NOT NULL"],
  ["domain default", "ALTER DOMAIN fixture.positive SET DEFAULT 2"],
  ["column typmod", "ALTER TABLE fixture.semantics ALTER COLUMN label TYPE varchar(12)"],
  ["column type", "ALTER TABLE fixture.semantics ALTER COLUMN label TYPE text"],
  ["generated expression", "ALTER TABLE fixture.semantics ALTER COLUMN calculated DROP EXPRESSION"],
  ["identity mode", "ALTER TABLE fixture.encrypted ALTER COLUMN id SET GENERATED ALWAYS"],
  [
    "partition bound",
    "ALTER TABLE fixture.partitioned DETACH PARTITION fixture.partition_one; ALTER TABLE fixture.partitioned ATTACH PARTITION fixture.partition_one FOR VALUES FROM (0) TO (20)",
  ],
);
for (const option of [
  "START WITH 38",
  "INCREMENT BY 2",
  "MINVALUE 0",
  "MAXVALUE 1000",
  "CACHE 2",
  "CYCLE",
  "AS integer",
])
  mutations.push([`sequence ${option}`, `ALTER SEQUENCE fixture.not_called ${option}`]);
let phase = "connect";
try {
  await client.connect();
  await client.query(
    "SET timezone='UTC'; SET DateStyle='ISO,YMD'; SET IntervalStyle='postgres'; SET bytea_output='hex'; SET extra_float_digits=3; SET search_path=pg_catalog,public;",
  );
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  const before = await captureInventory(client);
  for (const [name, sql] of mutations) {
    phase = name;
    await client.query("SAVEPOINT schema_negative");
    await client.query(sql);
    const changed = await captureInventory(client);
    for (const key of Object.keys(before).filter((key) => key !== "objects")) {
      if (name === "domain NOT NULL" && key === "constraints") {
        const retained = before.constraints.filter(
          (c) => !(c.schema === "fixture" && c.table === "" && c.name === "positive_not_null"),
        );
        assert.equal(retained.length, before.constraints.length - 1);
        assert.deepEqual(changed.constraints, retained);
      } else
        assert.equal(canonical(changed[key]), canonical(before[key]), `${name}: unchanged ${key}`);
    }
    const withoutDefinitions = (objects) =>
      objects
        .map(({ sha256, ...object }) => {
          void sha256;
          return object;
        })
        .sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
    assert.deepEqual(withoutDefinitions(changed.objects), withoutDefinitions(before.objects));
    assert.throws(
      () => compareInventories(before, { ...changed, constraints: before.constraints }),
      (error) => error.stage === "inventory-objects",
    );
    await client.query("ROLLBACK TO SAVEPOINT schema_negative; RELEASE SAVEPOINT schema_negative");
  }
  assert.equal(compareInventories(before, await captureInventory(client)), true);
  await client.query("ROLLBACK");
  process.stdout.write(
    JSON.stringify({
      kind: "synthetic-schema-integrity-negative",
      checks: mutations.map(([name]) => name),
      rowsJournalOwnersAclsUnchanged: true,
      comparisonRejected: true,
      rollbackVerified: true,
      inventoryBytes: Buffer.byteLength(canonical(before)),
      objectCount: before.objects.length,
    }) + "\n",
  );
} catch (error) {
  await writeFile(
    "/fixture/schema-failure.json",
    JSON.stringify({
      check: mutations.findIndex(([name]) => name === phase),
      code: /^[A-Z0-9_]+$/u.test(error.code ?? "") ? error.code : "UNKNOWN",
      stage: /^[a-z-]+$/u.test(error.stage ?? "") ? error.stage : "unknown",
    }),
    { mode: 0o600 },
  );
  process.stderr.write(`Synthetic schema integrity probe failed at ${phase}; details withheld.\n`);
  process.exitCode = 1;
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end().catch(() => {});
}
