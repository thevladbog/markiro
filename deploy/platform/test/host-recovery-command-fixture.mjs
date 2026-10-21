// Shared by the host-recovery-command test files. The slow cases live in files
// of their own so `node --test` runs them on separate workers: each makes
// hundreds of real fake-docker process calls and they used to run one after
// another in a single file.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { backupProof } from "./host-fixtures.mjs";
import { operationFixture } from "./host-command-fixture.mjs";
export const hash = (v) => createHash("sha256").update(v).digest("hex");
export async function fixture(t, existing) {
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
  const backupRuntime = await readFile(join(f.root, "backup-runtime.json")).catch(() => null);
  const provisionedRuntime =
    backupRuntime ??
    Buffer.from(
      JSON.stringify({
        version: 1,
        executorSha: f.identity.executorSha,
        dockerExecutable: "/usr/bin/docker",
        endpoint: "unix:///var/run/docker.sock",
        image: `sha256:${"e".repeat(64)}`,
        provenance: "live-source",
      }),
    );
  if (!backupRuntime)
    await writeFile(join(f.root, "backup-runtime.json"), provisionedRuntime, { mode: 0o600 });
  await writeFile(
    join(f.root, `recovery-backup-runtime-${f.identity.operationId}.json`),
    provisionedRuntime,
    { mode: 0o600 },
  );
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

export async function integration(t, mode) {
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

export async function activationFixture(t) {
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

/** Registers the expired-startup case for one service in the calling test file. */
export function expiredStartupTest({ service, uncertain }) {
  test(`actual activation wrapper cleans expired ${service} startup only when termination is confirmed: ${uncertain}`, async (t) => {
    const f = await activationFixture(t);
    const originalNow = Date.now;
    let current;
    t.after(() => {
      Date.now = originalNow;
    });
    Date.now = () => current ?? originalNow();
    const baseRun = f.options.runProcess;
    let started = false;
    let stops = 0;
    let afterUncertain = 0;
    f.options.runProcess = async (request) => {
      if (started && uncertain) afterUncertain++;
      const args = request.args.slice(2);
      if (args[0] === "container" && args[1] === "stop") stops++;
      const result = await baseRun(request);
      if (args[0] === "compose" && args.includes("up") && args.at(-1) === service) {
        started = true;
        current = Date.parse(f.record.operation.activation.admission.expiresAt) + 1;
        if (uncertain) throw Object.assign(new Error("unreaped"), { terminationConfirmed: false });
      }
      return result;
    };
    await assert.rejects(
      f.api.runRecoveryHostCommand(["activate", f.directory], f.options),
      (error) => {
        if (uncertain) assert.equal(error.terminationConfirmed, false);
        return true;
      },
    );
    assert.equal(started, true);
    if (uncertain) {
      assert.equal(afterUncertain, 0);
      assert.equal(stops, 0);
      await readFile(join(f.root, ".deploy.lock"));
    } else {
      assert.equal(stops, service === "api" ? 1 : 2);
      assert.equal(
        JSON.parse(await readFile(join(f.root, "recovery-state.json"))).status,
        "recovery-required",
      );
      await assert.rejects(readFile(join(f.root, ".deploy.lock")));
      const daemon = JSON.parse(await readFile(join(f.root, "daemon.json")));
      for (const c of daemon.containers.filter((c) =>
        ["api", "edge"].includes(c.Config.Labels["com.docker.compose.service"]),
      ))
        assert.equal(c.State.Running, false);
    }
  });
}
