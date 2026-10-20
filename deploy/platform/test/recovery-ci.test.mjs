import assert from "node:assert/strict";
import test from "node:test";
import {
  recoveryRoleMapping,
  validateWorkerManifest,
  cleanupRecoveryResources,
} from "../recovery-ci-helpers.mjs";
import { ICU_NODE_BASE, ICU_POSTGRES_BASE, workerRecipe } from "../backup/worker-recipes.mjs";
import { digest } from "../backup/schemas.mjs";
const sha = "a".repeat(40);
const manifest = () => ({
  version: 1,
  kind: "platform-recovery-worker",
  provenance: "local-synthetic",
  sourceSha: sha,
  image: { id: `sha256:${"b".repeat(64)}`, os: "linux", architecture: "amd64" },
  archive: { name: "recovery-image.tar", bytes: 123, sha256: "c".repeat(64) },
  sources: {
    sourceSha: sha,
    baseImages: [ICU_NODE_BASE, ICU_POSTGRES_BASE],
    buildRecipeSha256: digest(workerRecipe("icu")),
  },
});
test("recovery CI accepts only same-source tested ICU worker metadata", () => {
  assert.equal(validateWorkerManifest(manifest(), sha).image.id, manifest().image.id);
  for (const change of [
    (v) => {
      v.sourceSha = "d".repeat(40);
    },
    (v) => {
      v.provenance = "live-source";
    },
    (v) => {
      v.image.architecture = "arm64";
    },
    (v) => {
      v.archive.name = "../outside.tar";
    },
    (v) => {
      v.sources.buildRecipeSha256 = "e".repeat(64);
    },
  ]) {
    const value = manifest();
    change(value);
    assert.throws(() => validateWorkerManifest(value, sha));
  }
});
test("restore role mapping explicitly removes bootstrap privilege attributes", () => {
  const result = recoveryRoleMapping({
    roles: [
      {
        name: "postgres",
        superuser: true,
        createdb: true,
        createrole: true,
        replication: true,
        bypassrls: true,
      },
      { name: "markiro_app", superuser: false },
    ],
    objects: [],
  });
  assert.equal(result.allowedDeltas.length, 5);
  assert.deepEqual(result.roles, [
    { source: "markiro_app", target: "markiro_app" },
    { source: "postgres", target: "restored_bootstrap" },
  ]);
});
test("cleanup refuses a resource whose ownership changed", async () => {
  const calls = [];
  await assert.rejects(
    cleanupRecoveryResources([["volume", "markiro-platform_postgres-data"]], async (args) => {
      calls.push(args);
      return { stdout: JSON.stringify([{ Labels: { "com.docker.compose.project": "foreign" } }]) };
    }),
  );
  assert.equal(calls.length, 1);
});

test("cleanup removes labelled resources in reverse dependency order and verifies absence", async () => {
  const removed = [];
  const resources = [
    ["network", "markiro-platform_database"],
    ["volume", "markiro-platform_postgres-data"],
    ["container", "markiro-platform-postgres-1"],
  ];
  await cleanupRecoveryResources(resources, async (args) => {
    if (args[1] === "inspect")
      return {
        stdout: JSON.stringify([{ Labels: { "com.docker.compose.project": "markiro-platform" } }]),
      };
    if (args[1] === "rm") {
      removed.push([args[0], args.at(-1)]);
      return { stdout: "" };
    }
    assert.equal(args[1], "ls");
    return { stdout: "" };
  });
  assert.deepEqual(removed, [...resources].reverse());
});
test("cleanup fails closed if Docker still lists a removed resource", async () => {
  await assert.rejects(
    cleanupRecoveryResources([["volume", "markiro-platform_postgres-data"]], async (args) => ({
      stdout:
        args[1] === "inspect"
          ? JSON.stringify([{ Labels: { "com.docker.compose.project": "markiro-platform" } }])
          : "markiro-platform_postgres-data\n",
    })),
  );
});
test("role mapping retains actual owner and delegated grantee identities", () => {
  const value = recoveryRoleMapping({
    roles: [],
    objects: [
      {
        owner: "owner",
        acl: [
          { grantor: "delegator", grantee: "reader" },
          { grantor: "owner", grantee: "PUBLIC" },
        ],
      },
    ],
  });
  assert.deepEqual(
    value.roles.map((v) => v.source),
    ["delegator", "owner", "reader"],
  );
  assert.deepEqual(value.allowedDeltas, []);
});
