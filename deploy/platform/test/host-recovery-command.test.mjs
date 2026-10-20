import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, readFile, writeFile, unlink, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { backupProof } from "./host-fixtures.mjs";
import { operationFixture } from "./host-command-fixture.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
async function fixture(t, existing) {
  const api = await import("../host/recovery-command.mjs");
  const f = existing ?? (await operationFixture(t));
  for (const path of api.RECOVERY_BUNDLE_FILES) {
    const bytes = await readFile(new URL(`../../../${path}`, import.meta.url));
    await mkdir(dirname(join(f.installed, path)), { recursive: true, mode: 0o700 });
    const destination = join(f.installed, path);
    const priorBytes = await readFile(destination).catch(() => null);
    if (!priorBytes?.equals(bytes))
      await writeFile(destination, bytes, { mode: path.endsWith("pg_hba.conf") ? 0o644 : 0o600 });
    f.receipt.files[path] = hash(bytes);
  }
  const prior = structuredClone(f.identity);
  prior.operationId = randomUUID();
  const state = Buffer.from(
    JSON.stringify({
      version: 1,
      sequence: 14,
      previousHealthy: null,
      current: {
        identity: prior,
        phase: "api-started",
        status: "recovery-required",
        backup: backupProof(prior),
      },
    }),
  );
  await writeFile(join(f.root, "state.json"), state, { mode: 0o600 });
  const dispatch = { toolingSha: "a".repeat(40), runId: "1234", runAttempt: "1" };
  const admission = {
    version: 1,
    kind: "platform-failed-activation-recovery",
    identity: f.identity,
    predecessor: { identity: prior, sequence: 14, stateSha256: hash(state) },
    executorCi: f.receipt.ci,
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
  };
  const record = {
    version: 1,
    kind: "platform-recovery-host-operation",
    phase: "prepare",
    installedRoot: f.installed,
    dispatch,
    observationPolicy: f.record.observationPolicy,
    operation: {
      root: f.root,
      admission,
      configuration: f.record.deployment.configuration,
      dockerConfig: join(f.root, "docker"),
      connectionFile: join(f.root, "connection.json"),
      roleMapping: f.record.deployment.preparedPolicy.roleMapping,
    },
  };
  const receipt = {
    version: 1,
    kind: "platform-recovery-installed-executor",
    executorSha: f.identity.executorSha,
    operationId: f.identity.operationId,
    ci: f.receipt.ci,
    installationDispatch: dispatch,
    files: f.receipt.files,
  };
  const directoryFor = () =>
    join(f.root, "recovery-operations", f.identity.operationId, record.phase);
  const publish = async () => {
    await mkdir(directoryFor(), { recursive: true, mode: 0o700 });
    const token = await readFile(join(f.root, "github-token")).catch(() => null);
    if (token) await writeFile(join(directoryFor(), "github-token"), token, { mode: 0o600 });
    await writeFile(
      join(f.root, `recovery-installed-executor-${f.identity.operationId}.json`),
      JSON.stringify(receipt),
      { mode: 0o600 },
    );
    await writeFile(join(directoryFor(), "operation.json"), JSON.stringify(record), {
      mode: 0o600,
    });
  };
  if (!existing) await writeFile(join(f.root, "connection.json"), "{}", { mode: 0o600 });
  await publish();
  return {
    ...f,
    api,
    record,
    receipt,
    publish,
    get directory() {
      return directoryFor();
    },
    options: { root: f.root, installedRoot: f.installed, ambient: {} },
  };
}
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

async function integration(t, mode) {
  const { targetBackupFixture } = await import("./target-backup-fixture.mjs");
  const { integrationOptions } = await import("./host-command-integration-fixture.mjs");
  const producer = await targetBackupFixture(t, mode);
  const host = await integrationOptions(producer.f.root);
  const f = await fixture(t, producer.f);
  f.options = {
    ...host,
    ...producer.options,
    installedRoot: f.installed,
    root: f.root,
    ambient: {},
    runProcess: (request) =>
      request.executable === "/usr/bin/python3"
        ? host.runProcess(request)
        : producer.options.runProcess(request),
  };
  return Object.assign(f, { producer, host });
}
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

async function activationFixture(t) {
  const { commandIntegrationFixture, integrationOptions } =
    await import("./host-command-integration-fixture.mjs");
  const { withRecoveryState } = await import("../host/recovery-state.mjs");
  const { productionAuthorization } = await import("./production-activation-fixture.mjs");
  const base = await commandIntegrationFixture(t);
  const deployment = base.record.deployment;
  const options = await integrationOptions(base.root);
  const f = await fixture(t, base);
  const admission = f.record.operation.admission;
  const proof = {
    operationId: f.identity.operationId,
    target: f.identity.target,
    archiveSha256: f.backup.archiveSha256,
    restoreEvidenceSha256: f.restoreEvidence.evidenceSha256,
  };
  // Synthetic private archive fixtures model completed preparation. The public
  // activation still performs full archive validation and concrete observers.
  await withRecoveryState(f.root, admission, async (store) => {
    await store.complete("admitted");
    await store.enter("target-stopped");
    await store.complete("target-stopped");
    await store.enter("backup-verified");
    await store.complete("backup-verified", proof);
  });
  const preparation = await readFile(join(f.root, "recovery-state.json"));
  const preparedTarget = deployment.preparedTarget;
  preparedTarget.version = 2;
  const now = Date.now();
  preparedTarget.observations.egress.observedAt = new Date(now).toISOString();
  preparedTarget.observations.egress.value = productionAuthorization(preparedTarget, f, now);
  const daemon = JSON.parse(await readFile(join(f.root, "daemon.json")));
  daemon.activationProjection = preparedTarget.observations.egress.value.review.projection;
  await writeFile(join(f.root, "daemon.json"), JSON.stringify(daemon), { mode: 0o600 });
  f.record.phase = "activate";
  f.record.dispatch = { toolingSha: "b".repeat(40), runId: "5678", runAttempt: "1" };
  f.record.operation = {
    root: f.root,
    dockerConfig: deployment.dockerConfig,
    activation: {
      version: 1,
      kind: "platform-recovery-activation",
      admission,
      preparation: { sequence: 6, sha256: hash(preparation) },
      preparedTarget,
      preparedPolicy: deployment.preparedPolicy,
      configuration: deployment.configuration,
      dispatch: f.record.dispatch,
    },
  };
  await f.publish();
  f.options = { ...options, root: f.root };
  return Object.assign(f, { preparation });
}
test("activation command uses real adapters/full validator and permits newer dispatch while retaining pinned receipt", async (t) => {
  const f = await activationFixture(t);
  const original = await readFile(join(f.root, "state.json"));
  assert.deepEqual(await f.api.runRecoveryHostCommand(["activate", f.directory], f.options), {
    version: 1,
    kind: "platform-recovery-host-outcome",
    phase: "activate",
    status: "healthy",
  });
  assert.deepEqual(await readFile(join(f.root, "state.json")), original);
  assert.deepEqual(await readFile(join(f.root, "recovery-preparation.json")), f.preparation);
  assert.equal(JSON.parse(await readFile(join(f.root, "recovery-state.json"))).phase, "healthy");
  await assert.rejects(f.api.runRecoveryHostCommand(["activate", f.directory], f.options));
});

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
