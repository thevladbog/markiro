import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, chmod, symlink, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateFixture } from "./host-fixtures.mjs";
import { operationFixture } from "./host-command-fixture.mjs";

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

test("isolated host bundle includes every transitive runtime import", async (t) => {
  const { HOST_BUNDLE_FILES } = await import("../host/command.mjs");
  const f = await privateFixture(t);
  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  for (const relative of HOST_BUNDLE_FILES) {
    const target = join(f.root, relative);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(sourceRoot, relative), target);
  }
  const moduleUrl = pathToFileURL(join(f.root, "deploy/platform/host/command.mjs"));
  await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl.href)})`],
    {
      cwd: f.root,
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10000,
    },
  );
});

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

test("actual fixed CLI emits only the stable sanitized failure record", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("../host/command.mjs", import.meta.url)),
        "/missing/private-secret-path",
      ],
      { env: { PATH: "/usr/bin:/bin" }, timeout: 10000 },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.deepEqual(JSON.parse(error.stderr), {
        version: 1,
        kind: "platform-host-command-failure",
        code: "ERR_HOST_COMMAND",
        terminationConfirmed: null,
        recoveryRequired: false,
        durabilityUncertain: false,
      });
      assert.ok(!error.stderr.includes("private-secret-path"));
      return true;
    },
  );
});
