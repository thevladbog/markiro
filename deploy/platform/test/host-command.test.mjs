import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, chmod, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";

test("host command exposes only fixed data-directory CLI and rejects malformed/private file violations before commands", async (t) => {
  const { runHostCommand, loadHostOperation } = await import("../host/command.mjs");
  const f = await privateFixture(t);
  await assert.rejects(runHostCommand([]));
  await assert.rejects(runHostCommand([f.root, "arbitrary-command"]));
  await assert.rejects(runHostCommand(["relative"]));
  await writeFile(
    join(f.root, "operation.json"),
    JSON.stringify({ version: 1, execute: "touch /tmp/injected" }),
    { mode: 0o600 },
  );
  await assert.rejects(loadHostOperation(f.root));
  await chmod(join(f.root, "operation.json"), 0o644);
  await assert.rejects(loadHostOperation(f.root));
  await mkdir(join(f.root, "linked"), { mode: 0o700 });
  await symlink(join(f.root, "operation.json"), join(f.root, "linked", "operation.json"));
  await assert.rejects(loadHostOperation(join(f.root, "linked")));
});

test("source allowlist includes transitive trusted files and excludes CI overlay or caller adapters", async () => {
  const { HOST_BUNDLE_FILES } = await import("../host/command.mjs");
  assert.ok(HOST_BUNDLE_FILES.includes("deploy/platform/host/probe-worker.mjs"));
  assert.ok(HOST_BUNDLE_FILES.includes("deploy/platform/compose.compact.yml"));
  assert.ok(!HOST_BUNDLE_FILES.includes("deploy/platform/compose.ci.yml"));
  assert.equal(new Set(HOST_BUNDLE_FILES).size, HOST_BUNDLE_FILES.length);
});

async function operationFixture(t) {
  const { preparedFixture } = await import("./prepared-target-fixture.mjs");
  const { readFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { HOST_BUNDLE_FILES } = await import("../host/command.mjs");
  const { digest } = await import("../backup/schemas.mjs");
  const f = await preparedFixture(t);
  const installed = join(f.root, "installed");
  await mkdir(installed, { mode: 0o700 });
  const files = {};
  for (const path of HOST_BUNDLE_FILES) {
    const source = await readFile(new URL(`../../../${path}`, import.meta.url));
    await mkdir(dirname(join(installed, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(installed, path), source, {
      mode: path === "deploy/platform/postgres/pg_hba.conf" ? 0o644 : 0o600,
    });
    files[path] = digest(source);
  }
  f.identity.target = {
    hostId: "a".repeat(32),
    databaseId: "123456789",
    volumeId: "markiro-platform_postgres-data",
  };
  f.record.target = f.identity.target;
  f.document.target = f.identity.target;
  f.evidence.target = f.identity.target;
  f.document.provenance = "live-source";
  f.evidence.provenance = "live-source";
  f.record.provenance = "live-source";
  f.document.runtime.architecture = "amd64";
  f.evidence.runtime.architecture = "amd64";
  for (const pair of [f.document.fence, f.evidence.fence])
    for (const v of Object.values(pair)) v.target = f.identity.target;
  await f.publish();
  const preparedPolicy = Object.fromEntries(
    [
      "backup",
      "restoreEvidence",
      "roleMapping",
      "postgres",
      "tls",
      "rolePolicySha256",
      "provenance",
      "maxAgeMs",
      "producers",
    ].map((k) => [k, f.expected[k]]),
  );
  preparedPolicy.provenance = "live-source";
  const record = {
    version: 1,
    kind: "platform-host-operation",
    installedRoot: installed,
    deployment: {
      root: f.root,
      identity: f.identity,
      configuration: f.expected.configuration,
      dockerConfig: join(f.root, "docker"),
      preparedTarget: f.record,
      preparedPolicy,
    },
    observationPolicy: {
      machineId: "a".repeat(32),
      dockerId: "fixture-daemon",
      postgresImageId: `sha256:${"f".repeat(64)}`,
      volume: {
        name: "markiro-platform_postgres-data",
        createdAt: "2026-10-18T00:00:00Z",
        mountpoint: "/var/lib/docker/volumes/markiro-platform_postgres-data/_data",
      },
      networks: {
        default: { name: "markiro-platform_default", id: "1".repeat(64) },
        database: { name: "markiro-platform_database", id: "2".repeat(64) },
      },
    },
  };
  const receipt = {
    version: 1,
    kind: "platform-installed-executor",
    executorSha: f.identity.executorSha,
    ci: { runId: "123", runAttempt: "1" },
    files,
  };
  await writeFile(join(f.root, "installed-executor.json"), JSON.stringify(receipt), {
    mode: 0o600,
  });
  const publish = () =>
    writeFile(join(f.root, "operation.json"), JSON.stringify(record), { mode: 0o600 });
  await publish();
  return { ...f, record, installed, receipt, publish };
}

test("strict operation loads only byte-bound installed files, snapshots and real backup descriptors", async (t) => {
  const { loadHostOperation } = await import("../host/command.mjs");
  const f = await operationFixture(t);
  const loaded = await loadHostOperation(f.root, { installedRoot: f.installed, ambient: {} });
  assert.equal(loaded.record.deployment.identity.operationId, f.identity.operationId);
  await writeFile(join(f.installed, "deploy/platform/compose.yml"), "changed", { mode: 0o600 });
  await assert.rejects(loaded.verifySources());
});

for (const mutation of [
  "unknown top key",
  "missing deployment key",
  "extra policy",
  "extra source",
  "missing source",
  "changed executor",
  "changed composition",
  "public source",
  "linked source",
  "ambient injection",
  "synthetic substitution",
])
  test(`operation rejects ${mutation} before invocation`, async (t) => {
    const { loadHostOperation } = await import("../host/command.mjs");
    const { unlink } = await import("node:fs/promises");
    const f = await operationFixture(t);
    let ambient = {};
    if (mutation === "unknown top key") f.record.adapters = { writerFence: true };
    if (mutation === "missing deployment key") delete f.record.deployment.preparedTarget;
    if (mutation === "extra policy") f.record.observationPolicy.accepted = true;
    if (mutation === "changed executor") f.record.deployment.identity.executorSha = "0".repeat(40);
    if (mutation === "synthetic substitution")
      f.record.deployment.preparedPolicy.provenance = "local-synthetic";
    const source = join(f.installed, "deploy/platform/compose.yml");
    if (mutation === "extra source" || mutation === "missing source") {
      if (mutation === "extra source") f.receipt.files["caller.mjs"] = "a".repeat(64);
      else delete f.receipt.files["deploy/platform/compose.yml"];
      await writeFile(join(f.root, "installed-executor.json"), JSON.stringify(f.receipt), {
        mode: 0o600,
      });
    }
    if (mutation === "changed composition") await writeFile(source, "changed", { mode: 0o600 });
    if (mutation === "public source") await chmod(source, 0o644);
    if (mutation === "linked source") {
      await unlink(source);
      await symlink(join(f.installed, "deploy/platform/compose.compact.yml"), source);
    }
    if (mutation === "ambient injection") ambient = { NODE_OPTIONS: "--import attacker.mjs" };
    await f.publish();
    await assert.rejects(loadHostOperation(f.root, { installedRoot: f.installed, ambient }));
  });
