import assert from "node:assert/strict";
import { test } from "node:test";
import { mapInventory, roleSql, ownershipSql, compareInventories } from "../backup/inventory.mjs";
const role = {
  name: "provider_owner",
  login: true,
  superuser: false,
  createdb: false,
  createrole: false,
  replication: false,
  bypassrls: false,
  inherit: true,
  connectionLimit: -1,
};
const fixture = () => ({
  roles: [role],
  memberships: [],
  objects: [
    {
      kind: "SCHEMA",
      schema: "",
      name: "public",
      args: [],
      owner: "provider_owner",
      extension: null,
      acl: [
        {
          grantor: "provider_owner",
          grantee: "provider_owner",
          privilege: "USAGE",
          grantable: false,
        },
      ],
    },
  ],
  defaultPrivileges: [],
  extensions: [],
  tables: [{ schema: "public", name: "secret", count: "1", sha256: "a".repeat(64) }],
  sequences: [{ schema: "public", name: "seq", lastValue: "7", isCalled: false }],
  indexes: [
    {
      schema: "public",
      name: "idx",
      definitionSha256: "d".repeat(64),
      valid: true,
      ready: true,
      live: true,
    },
  ],
  constraints: [
    {
      schema: "public",
      table: "secret",
      name: "pk",
      definitionSha256: "e".repeat(64),
      validated: true,
    },
  ],
  migrationJournal: { count: "1", sha256: "b".repeat(64) },
});
const mapping = {
  version: 1,
  roles: [{ source: "provider_owner", target: "markiro_migrator" }],
  allowedDeltas: [],
};
test("maps owner and grants through exhaustive role map; SQL identifiers are quoted", () => {
  const mapped = mapInventory(fixture(), mapping);
  assert.equal(mapped.objects[0].owner, "markiro_migrator");
  assert.equal(mapped.objects[0].acl[0].grantor, "markiro_migrator");
  assert.match(roleSql(mapped), /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(ownershipSql(mapped), /ALTER SCHEMA "public" OWNER TO "markiro_migrator"/);
});
test("rejects missing mappings, implicit provider privileges and duplicate targets", () => {
  assert.throws(() => mapInventory(fixture(), { ...mapping, roles: [] }));
  const source = fixture();
  source.roles[0] = { ...role, superuser: true };
  assert.throws(() => mapInventory(source, mapping));
  const allowed = {
    ...mapping,
    allowedDeltas: [
      {
        kind: "role-attribute",
        source: "provider_owner",
        attribute: "superuser",
        from: true,
        to: false,
      },
    ],
  };
  assert.equal(mapInventory(source, allowed).roles[0].superuser, false);
  assert.throws(() => mapInventory(fixture(), { ...allowed }));
});
for (const [area, change] of [
  ["tables", (v) => (v[0].count = "2")],
  ["tables", (v) => (v[0].sha256 = "c".repeat(64))],
  ["sequences", (v) => (v[0].isCalled = true)],
  ["objects", (v) => (v[0].acl = [])],
  ["objects", (v) => (v[0].owner = "other")],
  ["defaultPrivileges", (v) => v.push({})],
  ["extensions", (v) => v.push({ name: "missing" })],
  ["migrationJournal", (v) => (v.sha256 = "c".repeat(64))],
  ["indexes", (v) => (v[0].valid = false)],
  ["constraints", (v) => (v[0].validated = false)],
])
  test(`rejects changed ${area}`, () => {
    const a = fixture(),
      b = structuredClone(a);
    change(b[area]);
    assert.throws(() => compareInventories(a, b));
  });

test("rejects changed index or constraint definition hashes and preserves intentional NOT VALID", () => {
  const a = fixture(),
    b = structuredClone(a);
  a.constraints[0].validated = false;
  b.constraints[0].validated = false;
  assert.equal(compareInventories(a, b), true);
  b.constraints[0].definitionSha256 = "f".repeat(64);
  assert.throws(() => compareInventories(a, b));
  const c = structuredClone(a);
  c.indexes[0].definitionSha256 = "f".repeat(64);
  assert.throws(() => compareInventories(a, c));
});

test("recreates mapped ownership of trusted extension members", () => {
  const source = fixture();
  source.objects[0] = {
    kind: "FUNCTION",
    schema: "public",
    name: "extension_member",
    args: [],
    owner: "provider_owner",
    extension: "btree_gist",
    acl: [],
  };
  assert.match(
    ownershipSql(mapInventory(source, mapping)),
    /ALTER FUNCTION "public"\."extension_member"\(\) OWNER TO "markiro_migrator"/,
  );
});

test("maps typed trusted-extension operators and access methods without unsupported ACL SQL", () => {
  const source = fixture();
  source.objects = [
    {
      kind: "OPERATOR",
      schema: "public",
      name: "<->",
      args: [
        { schema: "pg_catalog", name: "int4" },
        { schema: "pg_catalog", name: "int4" },
      ],
      owner: "provider_owner",
      extension: "btree_gist",
      acl: [],
    },
    {
      kind: "OPERATOR CLASS",
      schema: "public",
      name: "gist_int4_ops",
      method: "gist",
      args: [],
      owner: "provider_owner",
      extension: "btree_gist",
      acl: [],
    },
  ];
  const sql = ownershipSql(mapInventory(source, mapping));
  assert.match(
    sql,
    /ALTER OPERATOR "public"\.<->\("pg_catalog"\."int4","pg_catalog"\."int4"\) OWNER TO "markiro_migrator"/,
  );
  assert.match(
    sql,
    /ALTER OPERATOR CLASS "public"\."gist_int4_ops" USING "gist" OWNER TO "markiro_migrator"/,
  );
  assert.doesNotMatch(sql, /REVOKE ALL ON OPERATOR/);
});

test("temporary schema usage for lowered source-superuser grantors is revoked before exact schema ACL replay", () => {
  const source = fixture();
  source.objects.push({
    kind: "FUNCTION",
    schema: "public",
    name: "owned",
    args: [],
    owner: "provider_owner",
    extension: null,
    acl: [{ grantor: "provider_owner", grantee: "PUBLIC", privilege: "EXECUTE", grantable: false }],
  });
  const sql = ownershipSql(mapInventory(source, mapping));
  const grant = sql.indexOf('GRANT USAGE ON SCHEMA "public" TO "markiro_migrator";'),
    revoke = sql.indexOf('REVOKE USAGE ON SCHEMA "public" FROM "markiro_migrator";'),
    final = sql.indexOf('REVOKE ALL ON SCHEMA "public"');
  assert.ok(grant >= 0 && revoke > grant && final > revoke);
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;$/);
  assert.doesNotMatch(sql, /GRANT CREATE ON SCHEMA/);
});
