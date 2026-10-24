import assert from "node:assert/strict";
import test from "node:test";
import { chmod, readFile, writeFile, unlink, symlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
// The slow real-process cases run from host-recovery-activation-command and
// host-recovery-expired-*.test.mjs, on workers of their own.
import { activationFixture, fixture, integration } from "./host-recovery-command-fixture.mjs";

test("recovery loader accepts preparation without fabricated preparedTarget and preserves ordinary receipt", async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, "installed-executor.json"));
  const loaded = await f.api.loadRecoveryOperation(f.directory, f.options);
  assert.equal(loaded.record.phase, "prepare");
  assert.deepEqual(await readFile(join(f.root, "installed-executor.json")), before);
  await writeFile(
    join(f.installed, "deploy/platform/backup/source-state.mjs"),
    "throw new Error('secret')",
    { mode: 0o600 },
  );
  await assert.rejects(loaded.verifySources());
});
for (const change of [
  "callback",
  "extra receipt",
  "changed CI",
  "changed executor",
  "changed dispatch",
  "wrong root",
  "expired",
  "wrong predecessor",
  "wrong target",
  "missing source",
  "substituted dependency",
  "symlink",
  "public source",
]) {
  test(`recovery loader refuses ${change} before commands`, async (t) => {
    const f = await fixture(t);
    const source = join(f.installed, "deploy/platform/backup/source-state.mjs");
    if (change === "callback") f.record.operation.runProcess = "malicious";
    if (change === "extra receipt") f.receipt.override = true;
    if (change === "changed CI") f.receipt.ci = { runId: "999", runAttempt: "1" };
    if (change === "changed executor") f.receipt.executorSha = "0".repeat(40);
    if (change === "changed dispatch")
      f.receipt.installationDispatch = { ...f.receipt.installationDispatch, runId: "999" };
    if (change === "wrong root") f.record.installedRoot = f.root;
    if (change === "expired") f.record.operation.admission.expiresAt = new Date(0).toISOString();
    if (change === "wrong predecessor")
      f.record.operation.admission.predecessor.stateSha256 = "0".repeat(64);
    if (change === "wrong target")
      f.record.operation.admission.identity.target.hostId = "b".repeat(32);
    if (change === "missing source") await unlink(source);
    if (change === "substituted dependency")
      await writeFile(source, "throw new Error('secret')", { mode: 0o600 });
    if (change === "symlink") {
      await unlink(source);
      await symlink(join(f.installed, "deploy/platform/backup/schemas.mjs"), source);
    }
    if (change === "public source") await chmod(source, 0o644);
    await f.publish();
    await assert.rejects(f.api.loadRecoveryOperation(f.directory, f.options), (e) => {
      assert.equal(e.message, "Platform recovery host command failed.");
      return true;
    });
  });
}

test("isolated copied recovery bundle resolves every phase dependency", async (t) => {
  const f = await fixture(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { pathToFileURL } = await import("node:url");
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(join(f.installed, "deploy/platform/host/recovery-command-runtime.mjs")).href)})`,
    ],
    { cwd: f.installed, env: { PATH: "/usr/bin:/bin" }, timeout: 10000 },
  );
});

test("receipt, operation and immutable configuration bytes rechecked after load", async (t) => {
  for (const name of ["receipt", "operation"]) {
    const f = await fixture(t);
    const loaded = await f.api.loadRecoveryOperation(f.directory, f.options);
    const path =
      name === "receipt"
        ? join(f.root, `recovery-installed-executor-${f.identity.operationId}.json`)
        : join(f.directory, "operation.json");
    await writeFile(path, (await readFile(path)).toString() + " ", { mode: 0o600 });
    await assert.rejects(loaded.verifySources());
  }
});

test("prepare command exercises real publisher/CI/target/held backup path and reports backup-verified only", async (t) => {
  const f = await integration(t);
  const original = await readFile(join(f.root, "state.json"));
  const installed = await readFile(join(f.root, "installed-executor.json"));
  assert.deepEqual(await f.api.runRecoveryHostCommand(["prepare", f.directory], f.options), {
    version: 1,
    kind: "platform-recovery-host-outcome",
    phase: "prepare",
    status: "backup-verified",
  });
  const sidecar = JSON.parse(await readFile(join(f.root, "recovery-state.json")));
  assert.equal(sidecar.sequence, 6);
  assert.equal(sidecar.status, "completed");
  assert.equal(sidecar.backup.operationId, f.identity.operationId);
  assert.ok(f.producer.workerCommands() > 0);
  assert.deepEqual(await readFile(join(f.root, "state.json")), original);
  assert.deepEqual(await readFile(join(f.root, "installed-executor.json")), installed);
  await assert.rejects(f.api.runRecoveryHostCommand(["prepare", f.directory], f.options));
});

for (const mode of [
  "publisher",
  "artifact",
  "executor-ci",
  "physical-target",
  "failed-stop",
  "unreaped-stop",
]) {
  test(`public preparation fails closed for ${mode} with sanitized uncertainty`, async (t) => {
    const f = await integration(t);
    const options = { ...f.options };
    const originalRequest = options.request;
    let commands = 0;
    if (["publisher", "artifact", "executor-ci"].includes(mode))
      options.request = async (url, init) => {
        const response = await originalRequest(url, init);
        if (
          (mode === "publisher" && url.endsWith("/runs/456")) ||
          (mode === "artifact" && url.endsWith("/artifacts/789")) ||
          (mode === "executor-ci" && url.endsWith("/runs/124"))
        ) {
          const value = await response.json();
          if (mode === "artifact") value.digest = `sha256:${"0".repeat(64)}`;
          else value.conclusion = "failure";
          return new Response(JSON.stringify(value));
        }
        return response;
      };
    if (mode === "physical-target") options.readMachineId = async () => "0".repeat(32);
    if (mode.includes("stop")) {
      f.producer.daemon.containers.push(structuredClone(f.producer.daemon.templates.api));
      await f.producer.publish();
    }
    const originalRun = options.runProcess;
    options.runProcess = async (request) => {
      if (request.args[2] === "container" && request.args[3] === "stop") {
        commands++;
        throw Object.assign(
          new Error("private-secret-command-output"),
          mode === "unreaped-stop" ? { terminationConfirmed: false } : {},
        );
      }
      return originalRun(request);
    };
    await assert.rejects(
      f.api.runRecoveryHostCommand(["prepare", f.directory], options),
      (error) => {
        const protocol = f.api.recoveryCommandFailure(error);
        assert.ok(!JSON.stringify(protocol).includes("secret"));
        assert.equal(protocol.recoveryRequired, true);
        if (mode === "unreaped-stop") {
          assert.equal(protocol.durabilityUncertain, true);
          assert.equal(protocol.terminationConfirmed, false);
        }
        return true;
      },
    );
    assert.equal(f.producer.workerCommands(), 0);
    if (mode.includes("stop")) assert.equal(commands, 1);
  });
}

for (const mode of [
  "version1",
  "old-backup",
  "missing-backup",
  "changed-pinned-ci",
  "dispatch-mismatch",
]) {
  test(`activation loader rejects ${mode} before any process`, async (t) => {
    const f = await activationFixture(t);
    const activation = f.record.operation.activation;
    if (mode === "version1") activation.preparedTarget.version = 1;
    if (mode === "old-backup")
      activation.preparedTarget.observations.restoredSnapshot.value.archiveSha256 = "0".repeat(64);
    if (mode === "missing-backup") await unlink(activation.preparedPolicy.backup.archivePath);
    if (mode === "changed-pinned-ci")
      activation.admission.executorCi = { runId: "999", runAttempt: "1" };
    if (mode === "dispatch-mismatch")
      activation.dispatch = { ...activation.dispatch, runId: "999" };
    await f.publish();
    let commands = 0;
    await assert.rejects(
      f.api.runRecoveryHostCommand(["activate", f.directory], {
        ...f.options,
        runProcess: async () => {
          commands++;
          throw new Error("private-secret");
        },
      }),
    );
    assert.equal(commands, 0);
    assert.deepEqual(await readFile(join(f.root, "recovery-state.json")), f.preparation);
  });
}

test("production state/operation roots cannot be overridden by operation JSON", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.api.loadRecoveryOperation(f.directory, { installedRoot: f.installed, ambient: {} }),
  );
  await assert.rejects(f.api.loadRecoveryOperation(f.root, f.options));
  f.record.stateRoot = f.root;
  await f.publish();
  await assert.rejects(f.api.loadRecoveryOperation(f.directory, f.options));
});

for (const mode of ["missing", "wrong-executor", "wrong-operation"]) {
  test(`prepare preflight rejects ${mode} recovery runtime before stopping workloads`, async (t) => {
    const f = await integration(t);
    const name = join(f.root, `recovery-backup-runtime-${f.identity.operationId}.json`);
    if (mode === "missing") await unlink(name);
    else if (mode === "wrong-operation")
      await rename(name, join(f.root, `recovery-backup-runtime-${randomUUID()}.json`));
    else {
      const runtime = JSON.parse(await readFile(name));
      runtime.executorSha = "1".repeat(40);
      await writeFile(name, JSON.stringify(runtime), { mode: 0o600 });
    }
    let commands = 0;
    f.options.runProcess = async () => {
      commands++;
      throw new Error("must not spawn");
    };
    await assert.rejects(f.api.runRecoveryHostCommand(["prepare", f.directory], f.options));
    assert.equal(commands, 0);
  });
}

for (const original of [true, false]) {
  test(`prepare snapshots ${original ? "original" : "recovery"} runtime before any process`, async (t) => {
    const f = await integration(t);
    const baseRun = f.options.runProcess;
    let changed = false;
    let stops = 0;
    f.options.runProcess = async (request) => {
      if (request.args.includes("stop")) stops++;
      const result = await baseRun(request);
      if (!changed) {
        changed = true;
        const name = original
          ? "backup-runtime.json"
          : `recovery-backup-runtime-${f.identity.operationId}.json`;
        const path = join(f.root, name);
        await writeFile(path, (await readFile(path)).toString() + " ", { mode: 0o600 });
      }
      return result;
    };
    await assert.rejects(f.api.runRecoveryHostCommand(["prepare", f.directory], f.options));
    assert.equal(changed, true);
    assert.equal(stops, 0);
    assert.equal(f.producer.workerCommands(), 0);
  });
}
