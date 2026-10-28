import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonical, digest, ensure, hash, keys, runtime } from "../backup/schemas.mjs";
import { validateUpgradeAuthorization, validateUpgradeDispatch } from "../upgrade-dispatch.mjs";
import {
  readPrivateFile,
  assertPrivateRootSync,
  assertBindFileSync,
  inventoryDocumentOptions,
} from "./files.mjs";
import { validateForwardAdmission, validateForwardDecision } from "./forward-admission.mjs";
import { validateForwardSuccessorAdmission } from "./forward-successor-admission.mjs";
import { validateForwardJournal, forwardPhaseReceipt } from "./forward-state.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { validateObservationPolicy } from "./observe.mjs";
import {
  validateActivationReconciliation,
  validatePreservedForwardMetadata,
} from "./forward-activation-reconciliation.mjs";

export const failedActivationNames = Object.freeze([
  "state",
  "beforeActivation",
  "prepareConsumption",
  "activateConsumption",
  "prepareOperation",
  "activationOperation",
  "failure",
  "index",
  "predecessorIndex",
  "handoffIntent",
  "handoffSuccess",
  "installedExecutor",
  "backupRuntime",
  "retainedRuntime",
  "prepareDelivery",
  "prepareExecutionFence",
  "prepareCommandStarted",
  "activationDelivery",
  "activationExecutionFence",
  "activationCommandStarted",
  "lockIntent",
  "lockSuccess",
  "probeIntent",
  "probeSuccess",
  "beforeObservation",
  "afterObservation",
  "probeInspection",
  "archivedLock",
]);
const observations = new WeakMap();
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const same = (a, b) => ensure(canonical(a) === canonical(b));
const encode = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
function refusal() {
  const e = new Error("Failed forward activation predecessor rejected.");
  e.code = "ERR_HOST_FORWARD_ADMISSION";
  return e;
}
async function metadata(path) {
  const s = await lstat(path, { bigint: true });
  ensure(
    s.isFile() &&
      s.nlink === 1n &&
      s.uid === BigInt(process.getuid()) &&
      (s.mode & 0o7777n) === 0o600n,
  );
  return {
    dev: String(s.dev),
    ino: String(s.ino),
    uid: Number(s.uid),
    gid: Number(s.gid),
    mode: Number(s.mode & 0o7777n),
    size: String(s.size),
    mtimeNs: String(s.mtimeNs),
    ctimeNs: String(s.ctimeNs),
  };
}
async function directory(root, relative, names) {
  assertPrivateRootSync(join(root, relative));
  same((await readdir(join(root, relative))).sort(), [...names].sort());
}
export async function readFailedForwardActivationPredecessor(root, operationId, options = {}) {
  try {
    keys(
      options,
      Object.hasOwn(options, "indexFromSuccessorArchive")
        ? ["successorOperationId", "indexFromSuccessorArchive"]
        : [],
    );
    const { successorOperationId, indexFromSuccessorArchive = false } = options;
    ensure(uuid(operationId) && typeof indexFromSuccessorArchive === "boolean");
    if (indexFromSuccessorArchive)
      ensure(uuid(successorOperationId) && successorOperationId !== operationId);
    else ensure(successorOperationId === undefined);
    assertPrivateRootSync(root);
    assertPrivateRootSync(dirname(root));
    const dir = `forward-recovery-operations/${operationId}`;
    await directory(root, dir, [
      "state.json",
      "before-post-migration-activate.json",
      "prepare-consumption.json",
      "activate-consumption.json",
      "predecessor-index.json",
      "handoff-intent.json",
      "handoff-success.json",
    ]);
    const stateBytes = await readPrivateFile(root, `${dir}/state.json`);
    const state = snapshotActivation(JSON.parse(stateBytes));
    ensure(
      state.admission.kind === "platform-forward-admission-successor" &&
        uuid(state.admission.priorForward.identity.operationId),
    );
    validateUpgradeDispatch(state.decision.dispatch);
    const host = dirname(root),
      prepare = `upgrade-operations/${operationId}/post-migration-prepare`,
      activate = `upgrade-operations/${operationId}/post-migration-activate`;
    await directory(host, `upgrade-operations/${operationId}`, [
      "post-migration-prepare",
      "post-migration-activate",
    ]);
    const phaseFiles = [
      "operation.json",
      "github-token",
      "delivery.json",
      "execution-fence.json",
      "command-started.json",
    ];
    await directory(host, prepare, phaseFiles);
    await directory(host, activate, [...phaseFiles, "failure.json"]);
    const reconciliation = `reconciliations/${operationId}-activation-${state.decision.dispatch.runId}`;
    await directory(host, reconciliation, [
      "before.json",
      "after.json",
      "lock-intent.json",
      "lock-success.json",
      "probe-intent.json",
      "probe-success.json",
      "probe-inspection.json",
      "lock",
    ]);
    const result = { state: stateBytes };
    for (const [name, path] of Object.entries({
      beforeActivation: `${dir}/before-post-migration-activate.json`,
      prepareConsumption: `${dir}/prepare-consumption.json`,
      activateConsumption: `${dir}/activate-consumption.json`,
      index: indexFromSuccessorArchive
        ? `forward-recovery-operations/${successorOperationId}/predecessor-index.json`
        : "upgrade-index.json",
      predecessorIndex: `${dir}/predecessor-index.json`,
      handoffIntent: `${dir}/handoff-intent.json`,
      handoffSuccess: `${dir}/handoff-success.json`,
      installedExecutor: `upgrade-installed-executor-${operationId}.json`,
      backupRuntime: `forward-backup-runtime-${operationId}.json`,
    }))
      result[name] = await readPrivateFile(root, path);
    result.retainedRuntime = await readPrivateFile(
      root,
      `forward-retained-${operationId}.json`,
      inventoryDocumentOptions,
    );
    for (const [prefix, phase] of [
      ["prepare", prepare],
      ["activation", activate],
    ])
      for (const [suffix, file] of [
        ["Operation", "operation.json"],
        ["Delivery", "delivery.json"],
        ["ExecutionFence", "execution-fence.json"],
        ["CommandStarted", "command-started.json"],
      ])
        result[prefix + suffix] = await readPrivateFile(host, `${phase}/${file}`);
    result.failure = await readPrivateFile(host, `${activate}/failure.json`);
    for (const [name, file] of Object.entries({
      lockIntent: "lock-intent.json",
      lockSuccess: "lock-success.json",
      probeIntent: "probe-intent.json",
      probeSuccess: "probe-success.json",
      beforeObservation: "before.json",
      afterObservation: "after.json",
      probeInspection: "probe-inspection.json",
      archivedLock: "lock",
    }))
      result[name] = await readPrivateFile(host, `${reconciliation}/${file}`);
    keys(result, failedActivationNames);
    const installedReceipt = snapshotActivation(JSON.parse(result.installedExecutor));
    ensure(
      installedReceipt.executorSha === state.admission.identity.executorSha &&
        /^[a-f0-9]{40}$/u.test(installedReceipt.executorSha),
    );
    const installed = join(host, "upgrade-bootstrap", installedReceipt.executorSha);
    assertPrivateRootSync(installed);
    ensure(
      installedReceipt.files &&
        typeof installedReceipt.files === "object" &&
        !Array.isArray(installedReceipt.files),
    );
    const installedFiles = Object.entries(installedReceipt.files);
    ensure(installedFiles.length > 0 && installedFiles.length <= 256);
    for (const [relative, sha] of installedFiles) {
      ensure(
        /^deploy\/[a-zA-Z0-9_./-]+$/u.test(relative) &&
          !relative.split("/").some((p) => !p || p === "." || p === "..") &&
          hash(sha),
      );
      let bytes;
      if (relative === "deploy/platform/postgres/pg_hba.conf") {
        const path = join(installed, relative);
        assertBindFileSync(path);
        const info = await lstat(path);
        ensure([0, process.getuid()].includes(info.uid) && (info.mode & 0o7777) === 0o644);
        bytes = await readFile(path);
        assertBindFileSync(path);
      } else bytes = await readPrivateFile(installed, relative);
      ensure(digest(bytes) === sha);
    }
    const archiveMetadata = await metadata(join(host, reconciliation, "lock"));
    try {
      const current = await lstat(join(root, ".deploy.lock"), { bigint: true });
      // A later ordinary held lock may exist. The failed lock itself must have
      // moved, and normal EXCL acquisition still owns mutation serialization.
      ensure(
        String(current.dev) !== archiveMetadata.dev || String(current.ino) !== archiveMetadata.ino,
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    observations.set(result, {
      root,
      operationId,
      successorOperationId,
      hashes: Object.fromEntries(failedActivationNames.map((k) => [k, digest(result[k])])),
      archiveMetadata,
      predecessorMetadata: await metadata(join(root, dir, "predecessor-index.json")),
      activationMetadata: await metadata(join(host, activate, "operation.json")),
    });
    return Object.freeze(result);
  } catch {
    throw refusal();
  }
}
function envelope(record, phase, prior, decision, root, policy) {
  keys(record, [
    "version",
    "kind",
    "phase",
    "installedRoot",
    "dispatch",
    "authorization",
    "historicalSources",
    "observationPolicy",
    "operation",
  ]);
  ensure(
    record.version === 1 &&
      record.kind === "platform-forward-recovery-host-operation" &&
      record.phase === phase &&
      record.installedRoot === `${dirname(root)}/upgrade-bootstrap/${prior.identity.executorSha}`,
  );
  validateUpgradeAuthorization(record.authorization);
  validateUpgradeDispatch(record.dispatch);
  same(record.dispatch, phase === "post-migration-prepare" ? prior.dispatch : decision.dispatch);
  same(record.observationPolicy, policy);
  keys(record.historicalSources, [
    "recoveryReceiptSha256",
    "failedReceiptSha256",
    "priorForwardReceiptSha256",
  ]);
  ensure(Object.values(record.historicalSources).every(hash));
  same(
    record.historicalSources.priorForwardReceiptSha256,
    prior.priorForward.hashes.installedExecutor,
  );
  const op = record.operation;
  keys(op, [
    "root",
    "dockerConfig",
    "admission",
    "configuration",
    "predecessorContainers",
    ...(phase === "post-migration-prepare"
      ? ["connectionFile", "roleMapping"]
      : ["decision", "preparedTarget", "preparedPolicy"]),
  ]);
  ensure(
    op.root === root && op.dockerConfig === `${root}/docker` && uuid(op.configuration.candidateId),
  );
  same(op.admission, prior);
  same(op.predecessorContainers, prior.baseline.containers);
  if (phase === "post-migration-prepare") {
    ensure(typeof op.connectionFile === "string" && op.connectionFile.startsWith(`${root}/`));
    keys(op.roleMapping, ["version", "roles", "allowedDeltas"]);
    ensure(
      op.roleMapping.version === 1 &&
        Array.isArray(op.roleMapping.roles) &&
        Array.isArray(op.roleMapping.allowedDeltas),
    );
  } else {
    same(op.decision, decision);
    ensure(
      op.preparedTarget.version === 2 &&
        op.preparedTarget.provenance === "live-source" &&
        op.preparedPolicy.provenance === "live-source",
    );
  }
}
function phaseMarkers(records, prefix, phase, dispatch, prior) {
  const delivery = records[prefix + "Delivery"];
  keys(delivery, ["phase", "dispatch", "executorSha", "operationId", "bundleSha256"]);
  ensure(hash(delivery.bundleSha256));
  for (const record of [
    delivery,
    records[prefix + "ExecutionFence"],
    records[prefix + "CommandStarted"],
  ]) {
    same(record.dispatch, dispatch);
    ensure(
      record.phase === phase &&
        record.executorSha === prior.identity.executorSha &&
        record.operationId === prior.identity.operationId,
    );
  }
  for (const record of [records[prefix + "ExecutionFence"], records[prefix + "CommandStarted"]]) {
    keys(record, ["version", "phase", "dispatch", "executorSha", "operationId"]);
    ensure(record.version === 1);
  }
}
export function validateForwardActivationSuccessorAdmission(
  input,
  {
    failedActivationBytes,
    failedForwardBytes,
    failedUpgradeBytes,
    originalPredecessorBytes,
    productMigrationProof,
    now,
  },
) {
  try {
    const value = snapshotActivation(input),
      observation = observations.get(failedActivationBytes);
    ensure(observation && Number.isFinite(now));
    const { priorActivation, ...common } = value;
    ensure(value.kind === "platform-forward-activation-successor");
    keys(priorActivation, ["identity", "hashes"]);
    keys(priorActivation.hashes, failedActivationNames);
    keys(failedActivationBytes, failedActivationNames);
    const records = {};
    for (const name of failedActivationNames) {
      const bytes = failedActivationBytes[name],
        limit = name === "retainedRuntime" ? inventoryDocumentOptions.maxBytes : 1048576;
      ensure(
        Buffer.isBuffer(bytes) &&
          bytes.length > 0 &&
          bytes.length <= limit &&
          hash(priorActivation.hashes[name]) &&
          digest(bytes) === priorActivation.hashes[name] &&
          digest(bytes) === observation.hashes[name],
      );
      if (name !== "archivedLock") records[name] = snapshotActivation(JSON.parse(bytes));
    }
    const s = records.state,
      before = records.beforeActivation,
      prior = s.admission;
    ensure(prior.kind === "platform-forward-admission-successor");
    validateForwardJournal(before);
    validateForwardJournal(s, before);
    ensure(
      s.sequence === 10 &&
        s.phase === "api-started" &&
        s.status === "recovery-required" &&
        s.migrationEntered === true &&
        before.sequence === 6 &&
        before.phase === "backup-verified" &&
        before.status === "completed",
    );
    same(priorActivation.identity, prior.identity);
    ensure(
      observation.operationId === prior.identity.operationId &&
        (!observation.successorOperationId ||
          observation.successorOperationId === value.identity.operationId),
    );
    validateForwardDecision(s.decision, {
      priorBytes: failedActivationBytes.beforeActivation,
      prior: before,
      now: Date.parse(s.decision.expiresAt) - 1,
    });
    ensure(Date.parse(s.decision.expiresAt) < now);
    validateForwardSuccessorAdmission(prior, {
      failedForwardBytes,
      failedUpgradeBytes,
      originalPredecessorBytes,
      productMigrationProof,
      now: Date.parse(prior.expiresAt) - 1,
    });
    validateForwardAdmission(
      { ...common, kind: "platform-upgrade-forward-recovery" },
      { failedBytes: failedUpgradeBytes, originalPredecessorBytes, productMigrationProof, now },
    );
    for (const k of [
      "failed",
      "originalPredecessor",
      "oldConfigurationSha256",
      "failedConfigurationSha256",
      "candidateConfigurationSha256",
      "baseline",
    ])
      same(value[k], prior[k]);
    for (const k of ["admission", "target", "configurationSha256"])
      same(value.identity[k], prior.identity[k]);
    ensure(
      value.identity.operationId !== prior.identity.operationId &&
        value.identity.operationId !== prior.priorForward.identity.operationId &&
        value.identity.executorSha !== prior.identity.executorSha &&
        value.dispatch.runId !== prior.dispatch.runId &&
        value.dispatch.runId !== s.decision.dispatch.runId &&
        value.executorCi.runId !== prior.executorCi.runId,
    );
    ensure(
      failedActivationBytes.prepareConsumption.equals(encode(forwardPhaseReceipt(prior))) &&
        failedActivationBytes.activateConsumption.equals(encode(forwardPhaseReceipt(s.decision))) &&
        failedActivationBytes.predecessorIndex.equals(failedForwardBytes.index),
    );
    same(records.index, {
      version: 1,
      kind: "platform-forward-recovery-index",
      operationId: prior.identity.operationId,
      stateSha256: digest(failedActivationBytes.state),
      predecessorIndexSha256: prior.priorForward.hashes.index,
      admissionSha256: digest(encode(prior)),
    });
    const originalOperation = JSON.parse(originalPredecessorBytes.activationOperation);
    const policy = validateObservationPolicy(originalOperation.observationPolicy);
    envelope(
      records.prepareOperation,
      "post-migration-prepare",
      prior,
      s.decision,
      observation.root,
      originalOperation.observationPolicy,
    );
    envelope(
      records.activationOperation,
      "post-migration-activate",
      prior,
      s.decision,
      observation.root,
      originalOperation.observationPolicy,
    );
    same(records.prepareOperation.historicalSources, records.activationOperation.historicalSources);
    same(
      records.prepareOperation.operation.configuration,
      records.activationOperation.operation.configuration,
    );
    phaseMarkers(records, "prepare", "post-migration-prepare", prior.dispatch, prior);
    phaseMarkers(records, "activation", "post-migration-activate", s.decision.dispatch, prior);
    const receipt = records.installedExecutor;
    keys(receipt, [
      "version",
      "kind",
      "operationId",
      "executorSha",
      "ci",
      "installationDispatch",
      "files",
    ]);
    ensure(
      receipt.version === 1 &&
        receipt.kind === "platform-upgrade-installed-executor" &&
        receipt.operationId === prior.identity.operationId &&
        receipt.executorSha === prior.identity.executorSha,
    );
    same(receipt.ci, prior.executorCi);
    same(receipt.installationDispatch, prior.dispatch);
    const files = Object.entries(receipt.files);
    ensure(files.length > 0 && files.length <= 256);
    // The reader authenticated all installed bytes before minting provenance.
    // Runtime rereads this history at each existing guarded boundary.
    for (const [path, sha] of files)
      ensure(
        /^deploy\/[a-zA-Z0-9_./-]+$/u.test(path) &&
          !path.split("/").some((p) => !p || p === "." || p === "..") &&
          hash(sha),
      );
    const backup = runtime(records.backupRuntime);
    ensure(
      backup.executorSha === prior.identity.executorSha &&
        backup.provenance === "live-source" &&
        backup.dockerExecutable === "/usr/bin/docker" &&
        backup.endpoint === "unix:///var/run/docker.sock",
    );
    const retained = records.retainedRuntime;
    keys(retained, [
      "version",
      "kind",
      "operationId",
      "configurationSha256",
      "postgresImageId",
      "containers",
      "images",
    ]);
    ensure(
      retained.version === 1 &&
        retained.kind === "platform-forward-retained-runtime" &&
        retained.operationId === prior.identity.operationId &&
        retained.configurationSha256 === prior.candidateConfigurationSha256,
    );
    same(retained.postgresImageId, policy.postgresImageId);
    keys(retained.containers, ["postgres", "api", "edge"]);
    keys(retained.images, ["postgres", "api", "edge"]);
    for (const service of ["postgres", "api", "edge"]) {
      const c = retained.containers[service],
        image = retained.images[service],
        selected = prior.originalPredecessor.identity.admission.registry[service];
      const imageId = service === "postgres" ? retained.postgresImageId : selected.imageId;
      ensure(
        c.Id === prior.baseline.containers[service] &&
          c.Image === imageId &&
          image.Id === imageId &&
          image.Os === "linux" &&
          image.Architecture === "amd64" &&
          c.State.Running === (service === "postgres") &&
          c.State.Paused === false &&
          c.State.Restarting === false,
      );
      if (service === "postgres") ensure(c.State.Health?.Status === "healthy");
      else
        ensure(
          c.Config.Image === selected.reference && image.RepoDigests.includes(selected.reference),
        );
    }
    const intent = records.handoffIntent,
      success = records.handoffSuccess;
    keys(intent, [
      "version",
      "kind",
      "operationId",
      "failedOperationId",
      "expectedSha256",
      "originalMetadata",
      "admissionSha256",
    ]);
    keys(success, [
      "version",
      "kind",
      "operationId",
      "archivedSha256",
      "archivedMetadata",
      "originalMetadata",
      "intentSha256",
    ]);
    ensure(
      intent.version === 1 &&
        intent.kind === "platform-forward-index-handoff" &&
        intent.operationId === prior.identity.operationId &&
        intent.failedOperationId === prior.priorForward.identity.operationId &&
        intent.expectedSha256 === prior.priorForward.hashes.index &&
        intent.admissionSha256 === digest(encode(prior)),
    );
    ensure(
      success.version === 1 &&
        success.kind === "platform-forward-index-handoff-completed" &&
        success.operationId === prior.identity.operationId &&
        success.archivedSha256 === prior.priorForward.hashes.index &&
        success.intentSha256 === digest(failedActivationBytes.handoffIntent),
    );
    same(success.originalMetadata, intent.originalMetadata);
    same(success.archivedMetadata, observation.predecessorMetadata);
    validatePreservedForwardMetadata(intent.originalMetadata, success.archivedMetadata);
    const failure = records.failure;
    keys(failure, [
      "version",
      "kind",
      "operationId",
      "phase",
      "boundary",
      "commandCategory",
      "code",
      "errorName",
      "exitStatus",
      "executable",
      "terminationConfirmed",
      "durabilityUncertain",
    ]);
    ensure(
      failure.version === 1 &&
        failure.kind === "platform-host-failure" &&
        failure.operationId === prior.identity.operationId &&
        failure.phase === "api-started" &&
        failure.boundary === "command" &&
        failure.commandCategory === "validation" &&
        failure.code === "ERR_HOST_FORWARD_ADMISSION" &&
        failure.errorName === "Error" &&
        failure.exitStatus === null &&
        failure.executable === null &&
        failure.terminationConfirmed === false &&
        failure.durabilityUncertain === false,
    );
    validateActivationReconciliation(
      records,
      failedActivationBytes,
      observation,
      prior,
      s.decision,
      now,
    );
    // Historical guards validate at the immutable admission horizon. That
    // horizon must itself fit the original observation freshness window.
    if (value.version === 1)
      ensure(
        Date.parse(value.expiresAt) <= Date.parse(records.beforeObservation.observedAt) + 3600000,
      );
    return value;
  } catch {
    throw refusal();
  }
}
