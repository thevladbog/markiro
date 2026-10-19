/** Synthetic source-only regression probe. Never imported by production workers. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { captureInventory, compareInventories } from "./inventory.mjs";
import { canonical, digest } from "./schemas.mjs";
const require = createRequire(import.meta.url),
  { Client } = require("pg");
const client = new Client({
  host: "/var/run/postgresql",
  user: "postgres",
  database: "markiro",
  connectionTimeoutMillis: 15000,
  statement_timeout: 600000,
});
try {
  await client.connect();
  await client.query(
    "SET timezone='UTC'; SET DateStyle='ISO,YMD'; SET IntervalStyle='postgres'; SET bytea_output='hex'; SET extra_float_digits=3; SET search_path=pg_catalog,public;",
  );
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  const before = await captureInventory(client);
  const trigger = before.triggers.find(
    (t) =>
      t.schema === "public" &&
      t.table === "station_devices" &&
      t.name === "station_credential_epoch_advance",
  );
  const fn = before.objects.find(
    (o) =>
      o.kind === "FUNCTION" &&
      o.schema === "public" &&
      o.name === "station_credential_epoch_advance",
  );
  assert.equal(trigger?.enabled, "O");
  assert.ok(fn?.sha256);
  await client.query(
    "ALTER TABLE public.station_devices DISABLE TRIGGER station_credential_epoch_advance",
  );
  await client.query(
    "CREATE OR REPLACE FUNCTION public.station_credential_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$",
  );
  const changed = await captureInventory(client);
  for (const key of [
    "tables",
    "migrationJournal",
    "roles",
    "memberships",
    "defaultPrivileges",
    "extensions",
    "sequences",
    "indexes",
    "constraints",
  ])
    assert.equal(canonical(changed[key]), canonical(before[key]));
  const withoutDefinition = (objects) =>
    objects
      .map(({ sha256, ...object }) => {
        void sha256;
        return object;
      })
      .sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
  assert.equal(
    canonical(withoutDefinition(before.objects)),
    canonical(withoutDefinition(changed.objects)),
  );
  assert.throws(
    () => compareInventories(before, { ...changed, objects: before.objects }),
    (e) => e.stage === "inventory-triggers",
  );
  assert.throws(
    () => compareInventories(before, { ...changed, triggers: before.triggers }),
    (e) => e.stage === "inventory-objects",
  );
  assert.notEqual(
    changed.objects.find(
      (o) => o.kind === "FUNCTION" && o.schema === "public" && o.name === fn.name,
    ).sha256,
    fn.sha256,
  );
  await client.query("ROLLBACK");
  const restored = (
    await client.query(
      "SELECT pg_get_functiondef('public.station_credential_epoch_advance()'::regprocedure) AS definition",
    )
  ).rows[0].definition;
  assert.equal(digest(restored), fn.sha256);
  assert.equal(
    (
      await client.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.station_devices'::regclass AND tgname='station_credential_epoch_advance'",
      )
    ).rows[0].tgenabled,
    "O",
  );
  process.stdout.write(
    JSON.stringify({
      kind: "synthetic-executable-integrity-negative",
      checks: [
        "disabled current credential epoch trigger rejected",
        "changed current credential epoch function rejected",
        "rows journal owners ACLs unchanged",
        "transaction rolled back",
      ],
    }) + "\n",
  );
} catch {
  process.stderr.write("Synthetic executable integrity probe failed; details withheld.\n");
  process.exitCode = 1;
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end().catch(() => {});
}
