import assert from "node:assert/strict";
import test from "node:test";
import { createUpgradeSchemaObserver, upgradeSchemaQuery } from "../host/upgrade-schema.mjs";
import { withUpgradeState } from "../host/upgrade-state.mjs";
import { upgradeObservationFixture } from "./upgrade-observation-fixture.mjs";

test("schema fingerprint reads only fixed PostgreSQL catalog/migration SQL under a live upgrade guard", async (t) => {
  const f = await upgradeObservationFixture(t);
  let commands = 0;
  const inspect = createUpgradeSchemaObserver(
    { postgresId: f.predecessorContainers.postgres },
    {
      runProcess: async (request) => {
        commands++;
        assert.equal(request.executable, "/usr/bin/docker");
        assert.equal(request.args.at(-1), upgradeSchemaQuery);
        assert.ok(
          request.args.includes(
            "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000",
          ),
        );
        assert.ok(request.args.includes(f.predecessorContainers.postgres));
        return {
          stdout: JSON.stringify({
            systemId: f.input.identity.target.databaseId,
            schemaSha256: "a".repeat(64),
            migrationSha256: "b".repeat(64),
            migrationCount: "12",
          }),
        };
      },
    },
  );
  await withUpgradeState(
    f.root,
    f.input,
    async (store) => {
      const result = await store.guard(inspect);
      assert.equal(result.systemId, f.input.identity.target.databaseId);
      assert.equal(result.schemaSha256, "a".repeat(64));
    },
    { now: () => f.now },
  );
  assert.equal(commands, 1);
  await assert.rejects(inspect({}));
  assert.equal(commands, 1);
});
for (const [name, patch] of Object.entries({
  system: { systemId: "999" },
  schema: { schemaSha256: "oops" },
  migration: { migrationSha256: "oops" },
  count: { migrationCount: "-1" },
  extra: { raw: "private fixture" },
}))
  test(`schema observation rejects ${name}`, async (t) => {
    const f = await upgradeObservationFixture(t);
    const inspect = createUpgradeSchemaObserver(
      { postgresId: f.predecessorContainers.postgres },
      {
        runProcess: async () => ({
          stdout: JSON.stringify({
            systemId: f.input.identity.target.databaseId,
            schemaSha256: "a".repeat(64),
            migrationSha256: "b".repeat(64),
            migrationCount: "12",
            ...patch,
          }),
        }),
      },
    );
    await withUpgradeState(
      f.root,
      f.input,
      async (store) => {
        await assert.rejects(store.guard(inspect), (e) => !e.message.includes("private fixture"));
      },
      { now: () => f.now },
    );
  });
test("fixed fingerprint includes schema/roles/ACLs and migration rows, excludes changing sequence/data/statistics", () => {
  for (const name of [
    "pg_class",
    "pg_attribute",
    "pg_attrdef",
    "pg_constraint",
    "pg_index",
    "pg_proc",
    "pg_trigger",
    "pg_rewrite",
    "pg_authid",
    "pg_auth_members",
    "pg_default_acl",
    "pg_policy",
    "pg_sequence",
    "pg_extension",
    "pg_depend",
    "pg_inherits",
  ])
    assert.ok(upgradeSchemaQuery.includes(`pg_catalog.${name}`), name);
  assert.ok(upgradeSchemaQuery.includes("drizzle.__drizzle_migrations"));
  for (const name of [
    "relpages",
    "reltuples",
    "relallvisible",
    "relfrozenxid",
    "relminmxid",
    "datfrozenxid",
    "datminmxid",
  ])
    assert.ok(upgradeSchemaQuery.includes(`'${name}'`));
  assert.equal(
    /last_value|pg_stat_activity|pg_statistic|pg_stat_user_tables|SELECT \*/u.test(
      upgradeSchemaQuery,
    ),
    false,
  );
});
