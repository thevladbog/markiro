/** Disposable Linux rehearsal only. Never an installed executor or production admission. */
import assert from "node:assert/strict";
import { mkdir, open, readFile, rename, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { digest } from "./backup/schemas.mjs";
import { writePrivateFile } from "./host/files.mjs";
import { createDockerCommand } from "./host/observe.mjs";
import { sanitizeHostFailure } from "./host/failure-diagnostic.mjs";
import { forwardDecision } from "./test/forward-fixture.mjs";
import { forwardMetadata } from "./test/forward-state-fixture.mjs";
import { readFailedForwardActivationPredecessor } from "./host/forward-activation-successor-admission.mjs";
import { failedActivationExecutor } from "./forward-ci-predecessor.mjs";
const encode = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
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
  await assert.rejects(
    executor.state.withForwardActivationState(
      root,
      decision,
      async (store) => {
        await store.complete("activation-admitted");
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
              probe = await c.inspect("container", `markiro-platform-probe-${id}`);
              assert.equal(probe.State.Status, "exited");
              assert.equal(probe.State.ExitCode, 0);
              interruptedProbe = true;
              throw interrupted;
            }
            return result;
          },
        );
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
        assert.ok(probe);
        assert.ok(Date.parse(probe.State.FinishedAt) <= Date.parse(decision.expiresAt));

        // No receipt claims the future: wait at most the deliberate five-minute CI
        // lifetime, then use actual wall time for all successor observations.
        await delay(Math.max(0, Date.parse(decision.expiresAt) + 1 - Date.now()));
        syntheticNow = Date.now();
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
      containers[service] = {
        id: value.Id,
        imageId: value.Image,
        ...Object.fromEntries(
          ["Running", "Paused", "Restarting", "Status", "Health", "StartedAt", "FinishedAt"].map(
            (key) => [key, value.State[key] ?? (key === "Health" ? {} : undefined)],
          ),
        ),
      };
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
  assert.deepEqual(await c.inspect("container", probe.Id), probe);
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
  return { decision, bytes: await readFailedForwardActivationPredecessor(root, id) };
}
