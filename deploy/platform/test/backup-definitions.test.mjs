import assert from "node:assert/strict";
import { test } from "node:test";
import { captureInventory, compareInventories, mapInventory } from "../backup/inventory.mjs";

// Minimal catalog client: captureInventory must consult the semantic catalogs.
const column = () => ({
  name: "credential_epoch",
  typeSchema: "pg_catalog",
  typeName: "int4",
  typmod: -1,
  notNull: true,
  expression: "1",
  generated: "",
  identity: "",
  collationSchema: null,
  collationName: null,
});
async function captured({
  kind = "TABLE",
  columns = [column()],
  definition = {},
  domainConstraints = [],
} = {}) {
  const client = {
    query: async (sql) => {
      let rows = [];
      if (sql.includes("count(*)::int AS n")) rows = [{ n: 0 }];
      else if (sql.startsWith("SELECT 'DATABASE'"))
        rows = [
          {
            kind,
            schema: "public",
            name: "station_devices",
            owner: 1,
            acl: "{}",
            catalog: ["TYPE", "DOMAIN"].includes(kind) ? "pg_type" : "pg_class",
            oid: 42,
          },
        ];
      else if (sql === "SELECT pg_get_userbyid($1) AS name") rows = [{ name: "owner" }];
      else if (sql.includes("a.attname AS name")) rows = columns;
      else if (sql.includes("c.relkind AS kind"))
        rows = [
          { kind: "r", partitionKey: null, partitionBound: null, options: [], ...definition },
        ];
      else if (sql.includes("pg_get_viewdef")) rows = [{ query: " SELECT 1 AS x;", ...definition }];
      else if (sql.includes("FROM pg_sequence"))
        rows = [
          {
            typeSchema: "pg_catalog",
            typeName: "int8",
            start: "1",
            increment: "1",
            min: "1",
            max: "9223372036854775807",
            cache: "1",
            cycle: false,
            ...definition,
          },
        ];
      else if (sql.includes("t.typtype AS kind"))
        rows = [{ kind: kind === "DOMAIN" ? "d" : "e", defined: true, ...definition }];
      else if (sql.includes("FROM pg_enum"))
        rows = definition.labels ?? [{ label: "first" }, { label: "second" }];
      else if (sql.includes("t.typnotnull AS"))
        rows = [
          {
            notNull: true,
            expression: "1",
            typeSchema: "pg_catalog",
            typeName: "int4",
            typmod: -1,
            collationSchema: null,
            collationName: null,
            ...definition,
          },
        ];
      if (sql.includes("WHERE contypid=$1")) rows = domainConstraints;
      return { rows };
    },
  };
  return captureInventory(client);
}
for (const [name, mutate] of [
  [
    "NOT NULL",
    (c) => {
      c.notNull = false;
    },
  ],
  [
    "changed default",
    (c) => {
      c.expression = "2";
    },
  ],
  [
    "removed default",
    (c) => {
      c.expression = null;
    },
  ],
  [
    "resolved type",
    (c) => {
      c.typeName = "int8";
    },
  ],
  [
    "typmod",
    (c) => {
      c.typmod = 12;
    },
  ],
  [
    "identity",
    (c) => {
      c.identity = "a";
    },
  ],
  [
    "generated",
    (c) => {
      c.generated = "s";
    },
  ],
  [
    "column name",
    (c) => {
      c.name = "renamed";
    },
  ],
])
  test(`catalog equality rejects changed ${name} with unchanged rows and journal`, async () => {
    const c = column();
    mutate(c);
    const before = await captured(),
      after = await captured({ columns: [c] });
    assert.deepEqual(before.tables, after.tables);
    assert.deepEqual(before.migrationJournal, after.migrationJournal);
    assert.throws(
      () => compareInventories(before, after),
      (e) => e.stage === "inventory-objects",
    );
  });
test("column order is semantic; role mapping leaves definition intact", async () => {
  const a = column(),
    b = { ...column(), name: "security_revocation_revision", expression: "0" };
  const before = await captured({ columns: [a, b] });
  const after = await captured({ columns: [b, a] });
  assert.throws(
    () => compareInventories(before, after),
    (e) => e.stage === "inventory-objects",
  );
  const mapped = mapInventory(before, {
    version: 1,
    roles: [{ source: "owner", target: "renamed" }],
    allowedDeltas: [],
  });
  assert.equal(mapped.objects[0].sha256, before.objects[0].sha256);
  assert.match(before.objects[0].sha256, /^[a-f0-9]{64}$/u);
});
for (const [kind, definition] of [
  ["TABLE", { partitionKey: "RANGE (id)" }],
  ["VIEW", { query: " SELECT 2 AS x;" }],
  ["MATERIALIZED VIEW", { query: " SELECT 2 AS x;" }],
  ["SEQUENCE", { increment: "2" }],
  ["DOMAIN", { notNull: false }],
  ["TYPE", { labels: [{ label: "second" }, { label: "first" }] }],
])
  test(`catalog equality rejects changed ${kind} definition`, async () => {
    const before = await captured({ kind }),
      after = await captured({ kind, definition });
    assert.throws(
      () => compareInventories(before, after),
      (e) => e.stage === "inventory-objects",
    );
  });
test("unknown custom type semantics fail closed", async () => {
  await assert.rejects(captured({ kind: "TYPE", definition: { kind: "r" } }));
});
test("definition-bearing records require an exact valid fingerprint", async () => {
  const value = await captured();
  for (const change of [
    (o) => {
      delete o.sha256;
    },
    (o) => {
      o.sha256 = "bad";
    },
    (o) => {
      o.columns = [];
    },
  ]) {
    const other = structuredClone(value);
    change(other.objects[0]);
    assert.throws(() => compareInventories(other, other));
  }
});

test("old private definition key is rejected rather than reinterpreted", async () => {
  const old = await captured();
  old.objects[0].definitionSha256 = old.objects[0].sha256;
  delete old.objects[0].sha256;
  assert.throws(() => compareInventories(old, old));
});

test("domain constraint semantics are bound to the domain itself", async () => {
  const before = await captured({
    kind: "DOMAIN",
    domainConstraints: [{ name: "positive", definition: "CHECK (VALUE > 0)", validated: true }],
  });
  const after = await captured({
    kind: "DOMAIN",
    domainConstraints: [{ name: "positive", definition: "CHECK (VALUE > 1)", validated: true }],
  });
  assert.deepEqual(before.constraints, after.constraints);
  assert.throws(
    () => compareInventories(before, after),
    (e) => e.stage === "inventory-objects",
  );
});
