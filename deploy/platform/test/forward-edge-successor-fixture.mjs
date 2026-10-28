import { readFile, rename, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { forwardActivationSuccessorFixture } from "./forward-activation-successor-fixture.mjs";
import { forwardPrepared, forwardDecision } from "./forward-fixture.mjs";
import { forwardMetadata } from "./forward-state-fixture.mjs";
import { withForwardPreparationState, withForwardActivationState } from "../host/forward-state.mjs";
import { UPGRADE_BUNDLE_FILES } from "../host/upgrade-command.mjs";
import { forwardRuntimeDescriptor } from "./forward-backup-fixture.mjs";
import { digest } from "../backup/schemas.mjs";
import { readFailedForwardEdgePredecessor } from "../host/forward-edge-successor-admission.mjs";

export async function forwardEdgeSuccessorFixture(t, fixtureOptions) {
  const f = await forwardActivationSuccessorFixture(t, fixtureOptions),
    prior = structuredClone(f.input);
  const id = prior.identity.operationId,
    host = dirname(f.root),
    clock = { now: f.now };
  const options = {
    ...f.options,
    now: () => clock.now,
    productMigrationProof: f.productMigrationProof,
    verifyBaseline: async () => {},
    renameIndex: async ({ root, destination, checkpoint }) => {
      await checkpoint("before-rename");
      await rename(join(root, "upgrade-index.json"), join(root, destination));
      for (const p of ["after-rename", "source-parent-synced", "archive-parent-synced"])
        await checkpoint(p);
      return forwardMetadata(join(root, destination));
    },
  };
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
  const dir = join(f.root, "forward-recovery-operations", id);
  const before = JSON.parse(await readFile(join(dir, "state.json"))),
    decision = forwardDecision(f, before);
  await withForwardActivationState(
    f.root,
    decision,
    async (store) => {
      await store.complete("activation-admitted");
      await store.enter("api-started");
      await store.complete("api-started");
      await store.enter("edge-started");
      await store.fail();
    },
    options,
  );
  const currentBytes = await readFile(join(dir, "state.json"));
  const installedRoot = join(host, "upgrade-bootstrap", prior.identity.executorSha);
  const receipt = {
    version: 1,
    kind: "platform-upgrade-installed-executor",
    operationId: id,
    executorSha: prior.identity.executorSha,
    ci: prior.executorCi,
    installationDispatch: prior.dispatch,
    files: {},
  };
  for (const path of UPGRADE_BUNDLE_FILES) {
    const bytes = await readFile(new URL(`../../../${path}`, import.meta.url));
    await f.put(join(installedRoot, path), bytes, path.endsWith("pg_hba.conf") ? 0o644 : 0o600);
    if (path.endsWith("pg_hba.conf")) await chmod(join(installedRoot, path), 0o644);
    receipt.files[path] = digest(bytes);
  }
  await f.put(join(f.root, `upgrade-installed-executor-${id}.json`), receipt);
  await f.put(
    join(f.root, `forward-backup-runtime-${id}.json`),
    forwardRuntimeDescriptor(prior.identity.executorSha),
  );
  const retained = JSON.parse(f.failedActivationBytes.retainedRuntime);
  retained.operationId = id;
  retained.configurationSha256 = prior.candidateConfigurationSha256;
  // Older fixture metadata did not need the PG Config.Image field. The new
  // source observation binds the actual reference as well as its image ID.
  retained.containers.postgres.Config.Image ??= "postgres:17-alpine@sha256:" + "f".repeat(64);
  await f.put(join(f.root, `forward-retained-${id}.json`), retained);
  const historicalSources = {
    ...JSON.parse(f.failedActivationBytes.prepareOperation).historicalSources,
    priorActivationReceiptSha256: prior.priorActivation.hashes.installedExecutor,
  };
  for (const [phase, source, dispatch] of [
    ["post-migration-prepare", "prepareOperation", prior.dispatch],
    ["post-migration-activate", "activationOperation", decision.dispatch],
  ]) {
    const record = JSON.parse(f.failedActivationBytes[source]);
    Object.assign(record, { installedRoot, dispatch, historicalSources });
    Object.assign(record.operation, {
      admission: prior,
      predecessorContainers: prior.baseline.containers,
    });
    if (phase === "post-migration-activate") record.operation.decision = decision;
    const d = join(host, "upgrade-operations", id, phase);
    await f.put(join(d, "operation.json"), record);
    await f.put(join(d, "github-token"), Buffer.from("SYNTHETIC-PRIVATE-TOKEN"));
    const marker = {
      version: 1,
      phase,
      dispatch,
      executorSha: prior.identity.executorSha,
      operationId: id,
    };
    await f.put(join(d, "delivery.json"), {
      phase,
      dispatch,
      executorSha: prior.identity.executorSha,
      operationId: id,
      bundleSha256: "b".repeat(64),
    });
    for (const file of ["execution-fence.json", "command-started.json"])
      await f.put(join(d, file), marker);
  }
  await f.put(join(host, "upgrade-operations", id, "post-migration-activate", "failure.json"), {
    version: 1,
    kind: "platform-host-failure",
    operationId: id,
    phase: "edge-started",
    boundary: "command",
    commandCategory: "edge-up",
    code: "ERR_HOST_FORWARD_ADMISSION",
    errorName: "Error",
    exitStatus: null,
    executable: null,
    terminationConfirmed: false,
    durabilityUncertain: false,
  });
  clock.now = Math.max(Date.now() + 10, Date.parse(decision.expiresAt) + 1);
  const sourceIds = { ...prior.baseline.containers, api: "d".repeat(64) };
  const source = {
    version: 1,
    kind: "platform-forward-edge-source",
    operationId: id,
    stateSha256: digest(currentBytes),
    target: prior.identity.target,
    configurationSha256: prior.candidateConfigurationSha256,
    observedAt: new Date(clock.now).toISOString(),
    schema: prior.baseline.schema,
    productMigrationProofSha256: prior.baseline.productMigrationProofSha256,
    containers: {},
  };
  for (const service of ["postgres", "api", "edge"]) {
    const selected =
      service === "api"
        ? prior.identity.admission.registry.api
        : prior.originalPredecessor.identity.admission.registry[service];
    source.containers[service] = {
      id: sourceIds[service],
      imageId: service === "postgres" ? retained.postgresImageId : selected.imageId,
      reference:
        service === "postgres" ? retained.containers.postgres.Config.Image : selected.reference,
      running: service === "postgres",
      paused: false,
      restarting: false,
      status: service === "postgres" ? "running" : "exited",
      health: service === "postgres" ? "healthy" : null,
      exitCode: 0,
    };
  }
  await f.put(join(f.root, `forward-edge-source-${id}.json`), source);
  const failedEdgeBytes = await readFailedForwardEdgePredecessor(f.root, id);
  const input = {
    ...structuredClone(prior),
    version: 2,
    kind: "platform-forward-edge-successor",
    authority: "protected-dispatch-once",
    identity: {
      ...structuredClone(prior.identity),
      operationId: "b75b2c77-3785-4df0-8613-e70b0beafc57",
      executorSha: "0123456789abcdef0123456789abcdef01234567",
    },
    baseline: { ...structuredClone(prior.baseline), containers: sourceIds },
    executorCi: { runId: "998800101", runAttempt: "1" },
    dispatch: {
      toolingSha: "0123456789abcdef0123456789abcdef01234567",
      runId: "998800102",
      runAttempt: "1",
    },
    priorEdge: {
      identity: prior.identity,
      originalContainers: prior.baseline.containers,
      hashes: Object.fromEntries(Object.entries(failedEdgeBytes).map(([k, v]) => [k, digest(v)])),
    },
  };
  delete input.expiresAt;
  delete input.priorActivation;
  return {
    ...f,
    prior,
    decision,
    before,
    input,
    source,
    sourceIds,
    failedEdgeBytes,
    now: clock.now,
    clock,
    options,
    refreshEdge: () => readFailedForwardEdgePredecessor(f.root, id),
  };
}

export async function forwardEdgeCommandFixture(t) {
  const f = await forwardEdgeSuccessorFixture(t),
    id = f.input.identity.operationId,
    sha = f.input.identity.executorSha;
  t.mock.method(Date, "now", () => f.now);
  const record = JSON.parse(f.failedEdgeBytes.prepareOperation);
  record.installedRoot = join(dirname(f.root), "upgrade-bootstrap", sha);
  record.dispatch = f.input.dispatch;
  record.operation.admission = f.input;
  record.operation.predecessorContainers = f.input.baseline.containers;
  record.historicalSources.priorEdgeReceiptSha256 = f.input.priorEdge.hashes.installedExecutor;
  const directory = join(dirname(f.root), "upgrade-operations", id, "post-migration-prepare");
  const receipt = {
    version: 1,
    kind: "platform-upgrade-installed-executor",
    operationId: id,
    executorSha: sha,
    ci: f.input.executorCi,
    installationDispatch: f.input.dispatch,
    files: {},
  };
  for (const path of UPGRADE_BUNDLE_FILES) {
    const b = await readFile(new URL(`../../../${path}`, import.meta.url));
    await f.put(join(record.installedRoot, path), b);
    if (path.endsWith("pg_hba.conf")) await chmod(join(record.installedRoot, path), 0o644);
    receipt.files[path] = digest(b);
  }
  const publish = async () => {
    await f.put(join(directory, "operation.json"), record);
    await f.put(join(f.root, `upgrade-installed-executor-${id}.json`), receipt);
  };
  await f.put(join(directory, "github-token"), Buffer.from("SYNTHETIC-TOKEN"));
  await publish();
  await f.put(join(f.root, `forward-backup-runtime-${id}.json`), forwardRuntimeDescriptor(sha));
  return { ...f, record, directory, publish };
}
