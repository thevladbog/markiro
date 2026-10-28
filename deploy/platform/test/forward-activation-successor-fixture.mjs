// Synthetic filesystem history only; production authority needs the compiled
// physical verifier and separately approved concrete reconciliation receipts.
import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { forwardSuccessorFixture } from "./forward-successor-fixture.mjs";
import { forwardPrepared, forwardDecision } from "./forward-fixture.mjs";
import { forwardMetadata } from "./forward-state-fixture.mjs";
import { provisionForwardRuntimes } from "./forward-backup-fixture.mjs";
import { withForwardPreparationState, withForwardActivationState } from "../host/forward-state.mjs";
import { sanitizeHostFailure } from "../host/failure-diagnostic.mjs";
import { digest } from "../backup/schemas.mjs";
import { readFailedForwardPredecessor } from "../host/forward-successor-admission.mjs";
import { readFailedForwardActivationPredecessor } from "../host/forward-activation-successor-admission.mjs";

export async function forwardActivationSuccessorFixture(t, fixtureOptions) {
  const f = await forwardSuccessorFixture(t, fixtureOptions);
  const prior = structuredClone(f.input),
    id = prior.identity.operationId;
  const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.isBuffer(value) ? value : encode(value), { mode: 0o600 });
  };
  let now = Date.now();
  const options = {
    now: () => now,
    productMigrationProof: f.productMigrationProof,
    verifyBaseline: async () => {},
    renameIndex: async ({ root, destination, checkpoint }) => {
      await checkpoint("before-rename");
      await rename(join(root, "upgrade-index.json"), join(root, destination));
      for (const point of ["after-rename", "source-parent-synced", "archive-parent-synced"])
        await checkpoint(point);
      return forwardMetadata(join(root, destination));
    },
  };
  const prepareDirectory = join(
    dirname(f.root),
    "upgrade-operations",
    id,
    "post-migration-prepare",
  );
  const installedRoot = join(dirname(f.root), "upgrade-bootstrap", prior.identity.executorSha);
  const prepareRecord = structuredClone(f.record);
  prepareRecord.installedRoot = installedRoot;
  prepareRecord.dispatch = prior.dispatch;
  prepareRecord.historicalSources.priorForwardReceiptSha256 =
    prior.priorForward.hashes.installedExecutor;
  prepareRecord.operation.admission = prior;
  await put(join(prepareDirectory, "operation.json"), prepareRecord);
  await put(join(prepareDirectory, "github-token"), Buffer.from("SYNTHETIC-PRIVATE-JOB-TOKEN"));
  const receipt = {
    ...structuredClone(f.receipt),
    operationId: id,
    executorSha: prior.identity.executorSha,
    ci: prior.executorCi,
    installationDispatch: prior.dispatch,
  };
  for (const [relative] of Object.entries(receipt.files)) {
    const path = join(installedRoot, relative);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, await readFile(join(f.installed, relative)), {
      mode: relative.endsWith("pg_hba.conf") ? 0o644 : 0o600,
    });
  }
  await put(join(f.root, `upgrade-installed-executor-${id}.json`), receipt);
  await provisionForwardRuntimes(f);
  const marker = (dispatch) => ({
    version: 1,
    phase: "post-migration-prepare",
    executorSha: prior.identity.executorSha,
    operationId: id,
    dispatch,
  });
  await put(join(prepareDirectory, "delivery.json"), {
    ...marker(prior.dispatch),
    bundleSha256: "d".repeat(64),
  });
  // Delivery deliberately omits version in the established transport format.
  const delivery = JSON.parse(await readFile(join(prepareDirectory, "delivery.json")));
  delete delivery.version;
  await put(join(prepareDirectory, "delivery.json"), delivery);
  for (const name of ["execution-fence.json", "command-started.json"])
    await put(join(prepareDirectory, name), marker(prior.dispatch));
  await withForwardPreparationState(
    f.root,
    prior,
    async (store) => {
      const p = forwardPrepared(f);
      await store.complete("admitted", p.sourceRuntime);
      await store.enter("source-held");
      await store.complete("source-held");
      await store.enter("backup-verified");
      await store.complete("backup-verified", p.backup, p.preparation);
    },
    options,
  );
  const folder = join(f.root, "forward-recovery-operations", id);
  const before = JSON.parse(await readFile(join(folder, "state.json")));
  const decision = forwardDecision(f, before);
  decision.expiresAt = new Date(now + 60000).toISOString();
  const activationDirectory = join(
    dirname(f.root),
    "upgrade-operations",
    id,
    "post-migration-activate",
  );
  const activationRecord = {
    ...structuredClone(prepareRecord),
    phase: decision.phase,
    dispatch: decision.dispatch,
    operation: {
      root: f.root,
      dockerConfig: join(f.root, "docker"),
      admission: prior,
      configuration: prepareRecord.operation.configuration,
      predecessorContainers: prior.baseline.containers,
      decision,
      preparedTarget: { version: 2, provenance: "live-source" },
      preparedPolicy: { provenance: "live-source" },
    },
  };
  await put(join(activationDirectory, "operation.json"), activationRecord);
  await put(join(activationDirectory, "github-token"), Buffer.from("SYNTHETIC-PRIVATE-JOB-TOKEN"));
  const activationMarker = { ...marker(decision.dispatch), phase: decision.phase };
  await put(join(activationDirectory, "delivery.json"), {
    phase: decision.phase,
    dispatch: decision.dispatch,
    executorSha: prior.identity.executorSha,
    operationId: id,
    bundleSha256: "d".repeat(64),
  });
  for (const name of ["execution-fence.json", "command-started.json"])
    await put(join(activationDirectory, name), activationMarker);
  const expired = Object.assign(new Error("synthetic expired admission"), {
    code: "ERR_HOST_FORWARD_ADMISSION",
    terminationConfirmed: false,
  });
  await assert.rejects(
    withForwardActivationState(
      f.root,
      decision,
      async (store) => {
        await store.complete("activation-admitted");
        await store.enter("api-started");
        now = Date.parse(decision.expiresAt) + 1;
        await store.fail();
        throw expired;
      },
      options,
    ),
  );
  await put(
    join(activationDirectory, "failure.json"),
    sanitizeHostFailure(expired, {
      operationId: id,
      phase: "api-started",
      boundary: "command",
      commandCategory: "validation",
    }),
  );
  const current = JSON.parse(await readFile(join(folder, "state.json")));
  assert.equal(current.sequence, 10);
  assert.equal(current.status, "recovery-required");
  const containers = {},
    images = {};
  for (const service of ["postgres", "api", "edge"]) {
    const selected = prior.originalPredecessor.identity.admission.registry[service];
    const imageId = service === "postgres" ? f.policy.postgresImageId : selected.imageId;
    containers[service] = {
      Id: prior.baseline.containers[service],
      Image: imageId,
      Config: { Image: selected?.reference },
      State: {
        Running: service === "postgres",
        Paused: false,
        Restarting: false,
        Status: service === "postgres" ? "running" : "exited",
        Health: { Status: "healthy" },
        StartedAt: new Date(now - 86400000).toISOString(),
        FinishedAt:
          service === "postgres" ? "0001-01-01T00:00:00Z" : new Date(now - 86300000).toISOString(),
      },
    };
    images[service] = {
      Id: imageId,
      Os: "linux",
      Architecture: "amd64",
      RepoDigests: selected?.reference ? [selected.reference] : [],
    };
  }
  await put(join(f.root, `forward-retained-${id}.json`), {
    version: 1,
    kind: "platform-forward-retained-runtime",
    operationId: id,
    configurationSha256: prior.candidateConfigurationSha256,
    postgresImageId: images.postgres.Id,
    containers,
    images,
  });
  const reconciliation = join(
    dirname(f.root),
    "reconciliations",
    `${id}-activation-${decision.dispatch.runId}`,
  );
  await mkdir(reconciliation, { recursive: true, mode: 0o700 });
  const lock = join(f.root, ".deploy.lock"),
    originalLock = await forwardMetadata(lock);
  const lockBytes = await readFile(lock);
  const probeId = "d".repeat(64),
    probeImage = prior.identity.admission.registry.api;
  const probe = {
    Id: probeId,
    Name: `/markiro-platform-probe-${id}`,
    Image: probeImage.imageId,
    Config: {
      Image: probeImage.reference,
      User: `${process.getuid()}:${process.getgid()}`,
      Labels: { "io.markiro.probe-operation": id },
      Entrypoint: ["node"],
      Cmd: ["/probe/worker.mjs"],
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges:true"],
      PortBindings: {},
      NetworkMode: f.policy.networks.database.id,
    },
    NetworkSettings: {
      Networks: { [f.policy.networks.database.name]: { NetworkID: f.policy.networks.database.id } },
    },
    Mounts: [
      {
        Type: "bind",
        Source: join(f.root, "probes", "f6cc5dbd-1520-452e-a69d-16557ef18363", "connections.json"),
        Destination: "/input/connections.json",
        RW: false,
      },
      {
        Type: "bind",
        Source: join(f.root, "probes", "f6cc5dbd-1520-452e-a69d-16557ef18363", "ca.crt"),
        Destination: "/input/ca.crt",
        RW: false,
      },
      {
        Type: "bind",
        Source: join(installedRoot, "deploy/platform/host/probe-worker.mjs"),
        Destination: "/probe/worker.mjs",
        RW: false,
      },
    ],
    State: {
      Status: "exited",
      Running: false,
      Restarting: false,
      Paused: false,
      ExitCode: 0,
      Pid: 0,
      StartedAt: new Date(now - 3000).toISOString(),
      FinishedAt: new Date(now - 2000).toISOString(),
    },
  };
  const probeBytes = encode([probe]);
  await put(join(reconciliation, "probe-inspection.json"), probeBytes);
  const commonObservation = {
    version: 1,
    kind: "platform-forward-activation-reconciliation-observation",
    operationId: id,
    dispatch: decision.dispatch,
    stateSha256: digest(await readFile(join(folder, "state.json"))),
    schema: prior.baseline.schema,
    workers: [],
    containers: Object.fromEntries(
      Object.entries(containers).map(([service, c]) => [
        service,
        {
          id: c.Id,
          imageId: c.Image,
          ...c.State,
        },
      ]),
    ),
  };
  const preObservation = {
    ...commonObservation,
    observedAt: new Date(now).toISOString(),
    lock: { present: true, sha256: digest(lockBytes), metadata: originalLock },
    probe: { present: true, id: probeId, inspectionSha256: digest(probeBytes) },
  };
  await put(join(reconciliation, "before.json"), preObservation);
  const lockIntent = {
    version: 1,
    kind: "platform-forward-activation-lock-preservation",
    operationId: id,
    dispatch: decision.dispatch,
    stateSha256: commonObservation.stateSha256,
    observationSha256: digest(encode(preObservation)),
    lockSha256: digest(lockBytes),
    originalMetadata: originalLock,
  };
  await put(join(reconciliation, "lock-intent.json"), lockIntent);
  await rename(lock, join(reconciliation, "lock"));
  await put(join(reconciliation, "lock-success.json"), {
    version: 1,
    kind: "platform-forward-activation-lock-preservation-completed",
    operationId: id,
    intentSha256: digest(encode(lockIntent)),
    archivedSha256: digest(lockBytes),
    originalMetadata: originalLock,
    archivedMetadata: await forwardMetadata(join(reconciliation, "lock")),
  });
  const postObservation = {
    ...commonObservation,
    observedAt: new Date(now + 1).toISOString(),
    lock: { ...preObservation.lock, present: false },
    probe: { ...preObservation.probe, present: false },
  };
  const probeIntent = {
    version: 1,
    kind: "platform-forward-activation-probe-cleanup",
    operationId: id,
    dispatch: decision.dispatch,
    stateSha256: commonObservation.stateSha256,
    observationSha256: digest(encode(preObservation)),
    probeId,
    inspectionSha256: digest(probeBytes),
  };
  await put(join(reconciliation, "probe-intent.json"), probeIntent);
  await put(join(reconciliation, "after.json"), postObservation);
  await put(join(reconciliation, "probe-success.json"), {
    version: 1,
    kind: "platform-forward-activation-probe-cleanup-completed",
    operationId: id,
    intentSha256: digest(encode(probeIntent)),
    probeId,
    inspectionSha256: digest(probeBytes),
    observationSha256: digest(encode(postObservation)),
    absent: true,
    completedAt: postObservation.observedAt,
  });
  now += 1;
  const failedActivationBytes = await readFailedForwardActivationPredecessor(f.root, id);
  const failedForwardBytes = await readFailedForwardPredecessor(
    f.root,
    f.prior.identity.operationId,
    {
      successorOperationId: id,
      indexFromSuccessorArchive: true,
    },
  );
  const input = {
    ...structuredClone(prior),
    kind: "platform-forward-activation-successor",
    identity: {
      ...structuredClone(prior.identity),
      operationId: "a64a5336-7215-4bae-966c-69e3ef172b7a",
      executorSha: "a".repeat(40),
    },
    executorCi: { runId: "887654320", runAttempt: "1" },
    dispatch: { toolingSha: "a".repeat(40), runId: "887654321", runAttempt: "1" },
    expiresAt: new Date(now + 1800000).toISOString(),
    priorActivation: {
      identity: prior.identity,
      hashes: Object.fromEntries(
        Object.entries(failedActivationBytes).map(([k, v]) => [k, digest(v)]),
      ),
    },
  };
  delete input.priorForward;
  return {
    ...f,
    input,
    prior,
    decision,
    before,
    failedActivationBytes,
    failedForwardBytes,
    failedUpgradeBytes: { ...f.failedUpgradeBytes, index: failedForwardBytes.predecessorIndex },
    put,
    encode,
    now,
    reconciliation,
    activationDirectory,
    prepareDirectory,
    refresh: () => readFailedForwardActivationPredecessor(f.root, id),
  };
}
