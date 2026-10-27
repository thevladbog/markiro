/** Disposable Linux rehearsal only. Never an installed executor or production admission. */
import assert from "node:assert/strict";
import { mkdir, open, readFile, rename, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { digest } from "./backup/schemas.mjs";
import { snapshotActivation } from "./host/recovery-activation-admission.mjs";
import { writePrivateFile } from "./host/files.mjs";
import { createDockerCommand } from "./host/observe.mjs";
import { sanitizeHostFailure } from "./host/failure-diagnostic.mjs";
import { forwardDecision } from "./test/forward-fixture.mjs";
import { forwardMetadata } from "./test/forward-state-fixture.mjs";
import { readFailedForwardActivationPredecessor } from "./host/forward-activation-successor-admission.mjs";
import { failedActivationExecutor } from "./forward-ci-predecessor.mjs";
const encode = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
// Healthcheck timestamps and output rotate while container identity stays fixed.
// The reconciliation contract authenticates health status, not that telemetry.
export function projectActivationReconciliationContainer(input) {
  const value = snapshotActivation(input);
  return {
    id: value.Id,
    imageId: value.Image,
    ...Object.fromEntries(
      ["Running", "Paused", "Restarting", "Status", "StartedAt", "FinishedAt"].map((key) => [
        key,
        value.State[key],
      ]),
    ),
    Health: value.State.Health ? { Status: value.State.Health.Status } : {},
  };
}
export function assertSameExitedActivationProbe(before, after) {
  const stable = (input) => {
    const value = snapshotActivation(input);
    assert.equal(value.State.Status, "exited");
    for (const key of ["Running", "Paused", "Restarting"]) assert.equal(value.State[key], false);
    assert.equal(value.State.ExitCode, 0);
    assert.equal(value.State.Pid, 0);
    const state = { ...value.State };
    // An exited probe's success is established by exit status/PID. Keep every
    // other identity, recipe, mount, network and terminal-state field exact.
    delete state.Health;
    return { ...value, State: state };
  };
  assert.deepEqual(stable(after), stable(before));
}
export const forwardActivationSeedStages = Object.freeze({
  inputs: "seed activation: validate historical inputs",
  persist: "seed activation: persist immutable phase inputs",
  coordinator: "seed activation: enter historical coordinator",
  admitted: "seed activation: complete activation admission",
  enter: "seed activation: enter before API replacement",
  probe: "seed activation: execute historical role probe",
  probeResult: "seed activation: verify exited owned probe",
  deadline: "seed activation: verify probe deadline",
  wait: "seed activation: wait for controlled expiry",
  fail: "seed activation: persist exact expired failure",
  terminal: "seed activation: verify canonical terminal state",
  observation: "seed activation: record actual reconciliation observation",
  lock: "seed activation: preserve exact failed lock",
  cleanup: "seed activation: remove exact exited probe",
  receipts: "seed activation: verify cleanup receipts",
  predecessor: "seed activation: authenticate failed predecessor",
});
async function syncDirectory(path) {
  const fd = await open(path, "r");
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
// This clock is confined to the exact historical state coordinator. It lets the
// controlled failure reach sequence10 even if its physical probe takes longer
// than the deliberately short CI decision; all live probes use real time.
export async function seedExpiredForwardActivation({
  c,
  executor,
  admission,
  preparedState,
  prepareRecord,
  preparedTarget,
  preparedPolicy,
  proof,
  verifyBaseline,
  runProcess,
}) {
  c.progress(forwardActivationSeedStages.inputs);
  assert.equal(process.platform, "linux");
  assert.equal(executor.executorSha, failedActivationExecutor);
  assert.equal(admission.identity.executorSha, failedActivationExecutor);
  assert.equal(admission.kind, "platform-forward-admission-successor");
  await c.verifyIsolation();
  await executor.verify();
  const { root, parent, policy } = c,
    id = admission.identity.operationId;
  const prepareDirectory = join(parent, "upgrade-operations", id, "post-migration-prepare"),
    activationDirectory = join(parent, "upgrade-operations", id, "post-migration-activate");
  await mkdir(activationDirectory, { mode: 0o700 });
  const put = async (directory, name, value) =>
    writePrivateFile(directory, name, Buffer.isBuffer(value) ? value : encode(value));
  let probe;
  const clock = Date.now();
  const decision = forwardDecision({ input: admission }, preparedState);
  decision.dispatch.runId = "998203";
  decision.expiresAt = new Date(clock + 5 * 60000).toISOString();
  const activationRecord = {
    ...prepareRecord,
    phase: decision.phase,
    dispatch: decision.dispatch,
    operation: {
      root,
      dockerConfig: join(root, "docker"),
      admission,
      configuration: prepareRecord.operation.configuration,
      predecessorContainers: admission.baseline.containers,
      decision,
      preparedTarget,
      preparedPolicy,
    },
  };
  c.progress(forwardActivationSeedStages.persist);
  await put(activationDirectory, "operation.json", activationRecord);
  for (const [directory, phase, dispatch] of [
    [prepareDirectory, admission.phase, admission.dispatch],
    [activationDirectory, decision.phase, decision.dispatch],
  ]) {
    await put(directory, "github-token", Buffer.from("SYNTHETIC-PRIVATE-JOB-TOKEN"));
    const marker = {
      phase,
      executorSha: admission.identity.executorSha,
      operationId: id,
      dispatch,
    };
    await put(directory, "delivery.json", {
      ...marker,
      bundleSha256: digest(encode(phase === admission.phase ? prepareRecord : activationRecord)),
    });
    for (const name of ["execution-fence.json", "command-started.json"])
      await put(directory, name, { version: 1, ...marker });
  }
  let syntheticNow = clock,
    injectedExpiry = false;
  const expected = Object.assign(new Error("synthetic expiry before API replacement"), {
    code: "ERR_HOST_FORWARD_ADMISSION",
    terminationConfirmed: false,
  });
  c.progress(forwardActivationSeedStages.coordinator);
  await assert.rejects(
    executor.state.withForwardActivationState(
      root,
      decision,
      async (store) => {
        c.progress(forwardActivationSeedStages.admitted);
        await store.complete("activation-admitted");
        c.progress(forwardActivationSeedStages.enter);
        await store.enter("api-started");
        // Execute the historical real DB/TLS role probe, then deliberately report
        // uncertain transport after its actual successful start. Its normal cleanup
        // must retain the exact exited container for reconciliation.
        let interruptedProbe = false;
        const interrupted = Object.assign(new Error("synthetic retained probe transport"), {
          terminationConfirmed: false,
        });
        const command = createDockerCommand(
          { root, dockerConfig: join(root, "docker") },
          async (request, recheck) => {
            const result = await runProcess(request, recheck);
            if (request.args.includes("start")) {
              c.progress(forwardActivationSeedStages.probeResult);
              probe = await c.inspect("container", `markiro-platform-probe-${id}`);
              assert.equal(probe.State.Status, "exited");
              assert.equal(probe.State.ExitCode, 0);
              interruptedProbe = true;
              throw interrupted;
            }
            return result;
          },
        );
        c.progress(forwardActivationSeedStages.probe);
        await assert.rejects(
          executor.probe.runPostgresProbe({
            context: {
              root,
              identity: admission.identity,
              configuration: prepareRecord.operation.configuration,
            },
            policy,
            command,
            workerPath: join(executor.installedRoot, "deploy/platform/host/probe-worker.mjs"),
            verifySources: executor.verify,
          }),
          (error) => {
            if (!interruptedProbe) throw error;
            assert.equal(error.terminationConfirmed, false);
            return true;
          },
        );
        c.progress(forwardActivationSeedStages.deadline);
        assert.ok(probe);
        assert.ok(Date.parse(probe.State.FinishedAt) <= Date.parse(decision.expiresAt));

        // No receipt claims the future: wait at most the deliberate five-minute CI
        // lifetime, then use actual wall time for all successor observations.
        c.progress(forwardActivationSeedStages.wait);
        await delay(Math.max(0, Date.parse(decision.expiresAt) + 1 - Date.now()));
        syntheticNow = Date.now();
        c.progress(forwardActivationSeedStages.fail);
        await store.fail();
        injectedExpiry = true;
        throw expected;
      },
      { productMigrationProof: proof, verifyBaseline, now: () => syntheticNow },
    ),
    (error) => {
      if (!injectedExpiry) throw error;
      assert.equal(error.terminationConfirmed, false);
      return true;
    },
  );
  c.progress(forwardActivationSeedStages.terminal);
  const folder = join(root, "forward-recovery-operations", id),
    stateBytes = await readFile(join(folder, "state.json")),
    state = JSON.parse(stateBytes);
  assert.equal(state.sequence, 10);
  assert.equal(state.phase, "api-started");
  assert.equal(state.status, "recovery-required");
  await put(
    activationDirectory,
    "failure.json",
    sanitizeHostFailure(expected, {
      operationId: id,
      phase: "api-started",
      boundary: "command",
      commandCategory: "validation",
    }),
  );
  const reconciliation = join(
    parent,
    "reconciliations",
    `${id}-activation-${decision.dispatch.runId}`,
  );
  await mkdir(dirname(reconciliation), { mode: 0o700, recursive: true });
  await mkdir(reconciliation, { mode: 0o700 });
  const inspection = encode([probe]);
  await put(reconciliation, "probe-inspection.json", inspection);
  const lock = join(root, ".deploy.lock"),
    lockBytes = await readFile(lock),
    originalMetadata = await forwardMetadata(lock);
  const observe = async () => {
    await c.verifyIsolation();
    await executor.verify();
    assert.deepEqual(await readFile(join(folder, "state.json")), stateBytes);
    const lockPresent = await lstat(lock).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    const lockPath = lockPresent ? lock : join(reconciliation, "lock");
    assert.deepEqual(await readFile(lockPath), lockBytes);
    const currentMetadata = await forwardMetadata(lockPath);
    for (const key of Object.keys(originalMetadata))
      if (key !== "ctimeNs" || lockPresent)
        assert.equal(currentMetadata[key], originalMetadata[key]);
    const probeIds = String(
      (
        await c.nested([
          "container",
          "ls",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `id=${probe.Id}`,
        ])
      ).stdout,
    ).trim();
    assert.ok(probeIds === "" || probeIds === probe.Id);
    const probePresent = probeIds === probe.Id;
    const ledger = await executor.ledger.observeForwardMigrationLedger({
      postgresId: admission.baseline.containers.postgres,
      proof,
      root,
      runProcess,
    });
    assert.deepEqual(ledger.schema, admission.baseline.schema);
    const containers = {};
    for (const service of ["postgres", "api", "edge"]) {
      const value = await c.inspect("container", admission.baseline.containers[service]);
      assert.equal(value.State.Running, service === "postgres");
      containers[service] = projectActivationReconciliationContainer(value);
    }
    // No compiled worker is launched in this harness: the historical coordinator
    // has returned and every nested process above was awaited to completion.
    return {
      version: 1,
      kind: "platform-forward-activation-reconciliation-observation",
      operationId: id,
      dispatch: decision.dispatch,
      stateSha256: digest(stateBytes),
      schema: ledger.schema,
      workers: [],
      containers,
      observedAt: new Date().toISOString(),
      lock: { present: lockPresent, sha256: digest(lockBytes), metadata: originalMetadata },
      probe: { present: probePresent, id: probe.Id, inspectionSha256: digest(inspection) },
    };
  };
  c.progress(forwardActivationSeedStages.observation);
  const before = await observe();
  assert.equal(before.lock.present, true);
  assert.equal(before.probe.present, true);
  await put(reconciliation, "before.json", before);
  const lockIntent = {
    version: 1,
    kind: "platform-forward-activation-lock-preservation",
    operationId: id,
    dispatch: decision.dispatch,
    stateSha256: digest(stateBytes),
    observationSha256: digest(encode(before)),
    lockSha256: digest(lockBytes),
    originalMetadata,
  };
  await put(reconciliation, "lock-intent.json", lockIntent);
  await syncDirectory(reconciliation);
  // The entire destination directory was created exclusively above, in this
  // private single-coordinator namespace; no production lock helper uses this.
  c.progress(forwardActivationSeedStages.lock);
  assert.deepEqual((await observe()).containers, before.containers);
  await rename(lock, join(reconciliation, "lock"));
  await syncDirectory(root);
  await syncDirectory(reconciliation);
  await put(reconciliation, "lock-success.json", {
    version: 1,
    kind: "platform-forward-activation-lock-preservation-completed",
    operationId: id,
    intentSha256: digest(encode(lockIntent)),
    archivedSha256: digest(lockBytes),
    originalMetadata,
    archivedMetadata: await forwardMetadata(join(reconciliation, "lock")),
  });
  const probeIntent = {
    version: 1,
    kind: "platform-forward-activation-probe-cleanup",
    operationId: id,
    dispatch: decision.dispatch,
    stateSha256: digest(stateBytes),
    observationSha256: digest(encode(before)),
    probeId: probe.Id,
    inspectionSha256: digest(inspection),
  };
  await put(reconciliation, "probe-intent.json", probeIntent);
  await syncDirectory(reconciliation);
  await c.verifyIsolation();
  await executor.verify();
  assert.deepEqual((await observe()).containers, before.containers);
  c.progress(forwardActivationSeedStages.cleanup);
  assertSameExitedActivationProbe(probe, await c.inspect("container", probe.Id));
  await c.nested(["container", "rm", probe.Id]);
  assert.equal(
    String(
      (
        await c.nested([
          "container",
          "ls",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `id=${probe.Id}`,
        ])
      ).stdout,
    ).trim(),
    "",
  );
  c.progress(forwardActivationSeedStages.receipts);
  const after = await observe();
  assert.equal(after.lock.present, false);
  assert.equal(after.probe.present, false);
  await put(reconciliation, "after.json", after);
  await put(reconciliation, "probe-success.json", {
    version: 1,
    kind: "platform-forward-activation-probe-cleanup-completed",
    operationId: id,
    intentSha256: digest(encode(probeIntent)),
    probeId: probe.Id,
    inspectionSha256: digest(inspection),
    observationSha256: digest(encode(after)),
    absent: true,
    completedAt: after.observedAt,
  });
  await syncDirectory(reconciliation);
  c.progress(forwardActivationSeedStages.predecessor);
  return { decision, bytes: await readFailedForwardActivationPredecessor(root, id) };
}
