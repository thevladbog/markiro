import assert from "node:assert/strict";
import test from "node:test";
import {
  recoveryRoleMapping,
  validateWorkerManifest,
  cleanupRecoveryResources,
  captureRecoveryResource,
  recoveryCiLabel,
  recoveryCiErrorCategory,
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

function cleanupFixture() {
  const invocationId = "own";
  const values = new Map();
  const resources = [];
  for (const [kind, name, index] of [
    ["network", "markiro-platform_database", "1"],
    ["volume", "markiro-platform_postgres-data", "2"],
    ["container", "markiro-platform-postgres-1", "3"],
  ]) {
    const labels = {
      "com.docker.compose.project": "markiro-platform",
      [recoveryCiLabel]: invocationId,
    };
    const value = {
      Name: kind === "container" ? `/${name}` : name,
      ...(kind === "volume"
        ? {
            CreatedAt: "2026-10-20T00:00:00Z",
            Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
            Driver: "local",
            Scope: "local",
            Options: {},
            Labels: labels,
          }
        : {
            Id: index.repeat(64),
            ...(kind === "container" ? { Config: { Labels: labels } } : { Labels: labels }),
          }),
    };
    values.set(`${kind}:${name}`, value);
    resources.push(captureRecoveryResource(kind, name, value, invocationId));
  }
  const removed = [];
  const command = async (args) => {
    const [kind, action] = args;
    if (action === "ls")
      return {
        stdout: [...values.entries()]
          .filter(([key]) => key.startsWith(kind + ":"))
          .map(([key]) => key.slice(kind.length + 1))
          .join("\n"),
      };
    if (action === "inspect") return { stdout: JSON.stringify([values.get(`${kind}:${args[2]}`)]) };
    assert.equal(action, "rm");
    const target = args.at(-1);
    const entry = [...values.entries()].find(
      ([key, value]) =>
        key.startsWith(kind + ":") && (value.Id === target || key === `${kind}:${target}`),
    );
    assert.ok(entry);
    removed.push([kind, target]);
    values.delete(entry[0]);
    return { stdout: "" };
  };
  return { invocationId, values, resources, removed, command };
}
test("cleanup removes only recorded IDs in reverse dependency order", async () => {
  const f = cleanupFixture();
  await cleanupRecoveryResources(f.resources, f.command, f.invocationId);
  assert.deepEqual(f.removed, [
    ["container", "3".repeat(64)],
    ["volume", "markiro-platform_postgres-data"],
    ["network", "1".repeat(64)],
  ]);
});
for (const mode of [
  "container-replaced",
  "network-replaced",
  "volume-replaced",
  "foreign-invocation",
  "foreign-project",
  "same-project-extra",
])
  test(`cleanup refuses ${mode} before any deletion`, async () => {
    const f = cleanupFixture();
    const container = f.values.get("container:markiro-platform-postgres-1");
    if (mode === "container-replaced") container.Id = "4".repeat(64);
    if (mode === "network-replaced")
      f.values.get("network:markiro-platform_database").Id = "4".repeat(64);
    if (mode === "volume-replaced")
      f.values.get("volume:markiro-platform_postgres-data").CreatedAt = "2026-10-20T00:00:01Z";
    if (mode === "foreign-invocation") container.Config.Labels[recoveryCiLabel] = "foreign";
    if (mode === "foreign-project")
      container.Config.Labels["com.docker.compose.project"] = "foreign";
    if (mode === "same-project-extra")
      f.values.set("container:markiro-platform-foreign", {
        ...container,
        Name: "/markiro-platform-foreign",
        Id: "4".repeat(64),
      });
    await assert.rejects(cleanupRecoveryResources(f.resources, f.command, f.invocationId));
    assert.deepEqual(f.removed, []);
  });
test("cleanup fails closed if deletion does not establish absence", async () => {
  const f = cleanupFixture();
  await assert.rejects(
    cleanupRecoveryResources(
      f.resources,
      async (args) => (args[1] === "rm" ? { stdout: "" } : f.command(args)),
      f.invocationId,
    ),
  );
});

test("cleanup rechecks identity immediately before removal after initial verification", async () => {
  const f = cleanupFixture();
  const resource = f.resources.find((value) => value.kind === "container");
  for (const key of [...f.values.keys()]) if (!key.startsWith("container:")) f.values.delete(key);
  let inspections = 0;
  await assert.rejects(
    cleanupRecoveryResources(
      [resource],
      async (args) => {
        if (args[1] === "inspect" && ++inspections === 2)
          f.values.get("container:markiro-platform-postgres-1").Id = "4".repeat(64);
        return f.command(args);
      },
      f.invocationId,
    ),
  );
  assert.equal(inspections, 2);
  assert.deepEqual(f.removed, []);
});

test("recovery CI failure categories expose only allowlisted metadata", () => {
  for (const reason of [
    "spawn",
    "exit",
    "stdin",
    "output-limit",
    "timeout",
    "aborted",
    "termination",
  ])
    assert.equal(
      recoveryCiErrorCategory({ code: "ERR_HOST_PROCESS", reason }),
      `process-${reason}`,
    );
  assert.equal(recoveryCiErrorCategory({ code: "ERR_ASSERTION" }), "assertion");
  for (const error of [
    new Error("secret output and private path"),
    { code: "ERR_HOST_PROCESS", reason: "secret-output" },
    { code: "secret-path", message: "secret-output" },
    null,
  ])
    assert.equal(recoveryCiErrorCategory(error), "operation");
});
