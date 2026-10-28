import { dirname, join } from "node:path";
import { lstat, readdir, readFile } from "node:fs/promises";
import { canonical, digest, ensure, hash, keys, runtime, timestamp } from "../backup/schemas.mjs";
import { validateIdentity } from "./state-validation.mjs";
import { validateUpgradeAuthorization, validateUpgradeDispatch } from "../upgrade-dispatch.mjs";
import {
  readPrivateFile,
  assertPrivateRootSync,
  assertBindFileSync,
  inventoryDocumentOptions,
} from "./files.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { validateForwardAdmission, validateForwardDecision } from "./forward-admission.mjs";
import { validateForwardActivationSuccessorAdmission } from "./forward-activation-successor-admission.mjs";
import { validateForwardJournal, forwardPhaseReceipt } from "./forward-state.mjs";
import { validateForwardRetained } from "./forward-retained.mjs";
import { validatePreservedForwardMetadata } from "./forward-activation-reconciliation.mjs";
import { historicalOperationNow } from "./operation-authority.mjs";

export const failedEdgeNames = Object.freeze([
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
  "sourceObservation",
]);
const observations = new WeakMap();
const same = (a, b) => ensure(canonical(a) === canonical(b));
const encode = (value) => Buffer.from(JSON.stringify(value) + "\n");
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
function refusal() {
  const e = new Error("Stopped forward edge predecessor rejected.");
  e.code = "ERR_HOST_FORWARD_ADMISSION";
  return e;
}
async function exactDirectory(root, relative, files) {
  assertPrivateRootSync(join(root, relative));
  same((await readdir(join(root, relative))).sort(), [...files].sort());
}
async function privateMetadata(path) {
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
// One exact later generation only. It cannot recursively accept itself or a
// caller-built JSON reader observation; actual mutation still needs live guards.
export async function readFailedForwardEdgePredecessor(root, operationId, options = {}) {
  try {
    keys(
      options,
      Object.hasOwn(options, "indexFromSuccessorArchive")
        ? ["successorOperationId", "indexFromSuccessorArchive"]
        : [],
    );
    const { successorOperationId, indexFromSuccessorArchive = false } = options;
    ensure(uuid(operationId) && typeof indexFromSuccessorArchive === "boolean");
    ensure(
      indexFromSuccessorArchive
        ? uuid(successorOperationId) && successorOperationId !== operationId
        : successorOperationId === undefined,
    );
    assertPrivateRootSync(root);
    assertPrivateRootSync(dirname(root));
    const dir = `forward-recovery-operations/${operationId}`,
      host = dirname(root),
      base = `upgrade-operations/${operationId}`;
    await exactDirectory(root, dir, [
      "state.json",
      "before-post-migration-activate.json",
      "prepare-consumption.json",
      "activate-consumption.json",
      "predecessor-index.json",
      "handoff-intent.json",
      "handoff-success.json",
    ]);
    await exactDirectory(host, base, ["post-migration-prepare", "post-migration-activate"]);
    const phaseFiles = [
      "operation.json",
      "github-token",
      "delivery.json",
      "execution-fence.json",
      "command-started.json",
    ];
    await exactDirectory(host, base + "/post-migration-prepare", phaseFiles);
    await exactDirectory(host, base + "/post-migration-activate", [...phaseFiles, "failure.json"]);
    const result = {};
    for (const [name, path] of Object.entries({
      state: dir + "/state.json",
      beforeActivation: dir + "/before-post-migration-activate.json",
      prepareConsumption: dir + "/prepare-consumption.json",
      activateConsumption: dir + "/activate-consumption.json",
      index: indexFromSuccessorArchive
        ? `forward-recovery-operations/${successorOperationId}/predecessor-index.json`
        : "upgrade-index.json",
      predecessorIndex: dir + "/predecessor-index.json",
      handoffIntent: dir + "/handoff-intent.json",
      handoffSuccess: dir + "/handoff-success.json",
      installedExecutor: `upgrade-installed-executor-${operationId}.json`,
      backupRuntime: `forward-backup-runtime-${operationId}.json`,
      retainedRuntime: `forward-retained-${operationId}.json`,
      sourceObservation: `forward-edge-source-${operationId}.json`,
    }))
      result[name] = await readPrivateFile(
        root,
        path,
        name === "retainedRuntime" ? inventoryDocumentOptions : undefined,
      );
    const state = JSON.parse(result.state);
    ensure(
      state.admission.kind === "platform-forward-activation-successor" &&
        state.admission.identity.operationId === operationId,
    );
    for (const [prefix, phase] of [
      ["prepare", "post-migration-prepare"],
      ["activation", "post-migration-activate"],
    ]) {
      for (const [name, file] of [
        [prefix + "Operation", "operation.json"],
        [prefix + "Delivery", "delivery.json"],
        [prefix + "ExecutionFence", "execution-fence.json"],
        [prefix + "CommandStarted", "command-started.json"],
      ]) {
        const target = name === "activationOperation" ? "activationOperation" : name;
        result[target] = await readPrivateFile(host, base + "/" + phase + "/" + file);
      }
    }
    result.failure = await readPrivateFile(host, base + "/post-migration-activate/failure.json");
    keys(result, failedEdgeNames);
    const receipt = JSON.parse(result.installedExecutor),
      installed = join(host, "upgrade-bootstrap", state.admission.identity.executorSha);
    assertPrivateRootSync(installed);
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
        receipt.operationId === operationId &&
        receipt.executorSha === state.admission.identity.executorSha,
    );
    const files = Object.entries(receipt.files);
    ensure(files.length > 0 && files.length <= 256);
    for (const [path, sha] of files) {
      ensure(
        /^deploy\/[a-zA-Z0-9_./-]+$/u.test(path) &&
          !path.split("/").some((p) => !p || p === "." || p === "..") &&
          hash(sha),
      );
      let bytes;
      if (path === "deploy/platform/postgres/pg_hba.conf") {
        const p = join(installed, path);
        assertBindFileSync(p);
        const s = await lstat(p);
        ensure([0, process.getuid()].includes(s.uid) && (s.mode & 0o7777) === 0o644);
        bytes = await readFile(p);
        assertBindFileSync(p);
      } else bytes = await readPrivateFile(installed, path);
      ensure(digest(bytes) === sha);
    }
    observations.set(result, {
      root,
      operationId,
      successorOperationId,
      hashes: Object.fromEntries(failedEdgeNames.map((k) => [k, digest(result[k])])),
      predecessorMetadata: await privateMetadata(join(root, dir, "predecessor-index.json")),
      stateMetadata: await privateMetadata(join(root, dir, "state.json")),
    });
    return Object.freeze(result);
  } catch {
    throw refusal();
  }
}
function envelope(record, phase, prior, decision, root, historicalSources, policy) {
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
      record.installedRoot === join(dirname(root), "upgrade-bootstrap", prior.identity.executorSha),
  );
  validateUpgradeAuthorization(record.authorization);
  validateUpgradeDispatch(record.dispatch);
  same(record.dispatch, phase === "post-migration-prepare" ? prior.dispatch : decision.dispatch);
  same(record.historicalSources, historicalSources);
  same(record.observationPolicy, policy);
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
    op.root === root && op.dockerConfig === root + "/docker" && uuid(op.configuration.candidateId),
  );
  same(op.admission, prior);
  same(op.predecessorContainers, prior.baseline.containers);
  if (phase === "post-migration-prepare") {
    ensure(typeof op.connectionFile === "string" && op.connectionFile.startsWith(root + "/"));
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
function markers(r, prefix, phase, dispatch, prior) {
  keys(r[prefix + "Delivery"], ["phase", "dispatch", "executorSha", "operationId", "bundleSha256"]);
  ensure(hash(r[prefix + "Delivery"].bundleSha256));
  for (const suffix of ["Delivery", "ExecutionFence", "CommandStarted"]) {
    const v = r[prefix + suffix];
    if (suffix !== "Delivery") {
      keys(v, ["version", "phase", "dispatch", "executorSha", "operationId"]);
      ensure(v.version === 1);
    }
    ensure(
      v.phase === phase &&
        v.executorSha === prior.identity.executorSha &&
        v.operationId === prior.identity.operationId,
    );
    same(v.dispatch, dispatch);
  }
}
export function validateForwardEdgeSuccessorAdmission(
  input,
  { failedEdgeBytes, history, productMigrationProof, now },
) {
  try {
    const value = snapshotActivation(input),
      observation = observations.get(failedEdgeBytes);
    ensure(observation && Number.isSafeInteger(now));
    const { priorEdge, ...common } = value;
    ensure(value.version === 2 && value.kind === "platform-forward-edge-successor");
    keys(priorEdge, ["identity", "originalContainers", "hashes"]);
    validateIdentity(priorEdge.identity);
    keys(priorEdge.hashes, failedEdgeNames);
    keys(failedEdgeBytes, failedEdgeNames);
    const r = {};
    for (const name of failedEdgeNames) {
      const b = failedEdgeBytes[name];
      ensure(
        Buffer.isBuffer(b) &&
          b.length > 0 &&
          b.length <= (name === "retainedRuntime" ? inventoryDocumentOptions.maxBytes : 1048576) &&
          hash(priorEdge.hashes[name]) &&
          digest(b) === priorEdge.hashes[name] &&
          digest(b) === observation.hashes[name],
      );
      r[name] = snapshotActivation(JSON.parse(b));
    }
    const s = r.state,
      before = r.beforeActivation,
      prior = s.admission;
    ensure(
      prior.version === 1 &&
        prior.kind === "platform-forward-activation-successor" &&
        s.decision.version === 1,
    );
    validateForwardJournal(before);
    validateForwardJournal(s, before);
    ensure(
      s.sequence === 12 &&
        s.phase === "edge-started" &&
        s.status === "recovery-required" &&
        s.migrationEntered === true &&
        before.sequence === 6 &&
        before.phase === "backup-verified" &&
        before.status === "completed",
    );
    same(priorEdge.identity, prior.identity);
    same(priorEdge.originalContainers, prior.baseline.containers);
    ensure(
      observation.operationId === prior.identity.operationId &&
        (!observation.successorOperationId ||
          observation.successorOperationId === value.identity.operationId),
    );
    validateForwardDecision(s.decision, {
      priorBytes: failedEdgeBytes.beforeActivation,
      prior: before,
      now: historicalOperationNow(s.decision),
    });
    ensure(timestamp(s.decision.expiresAt) < now);
    validateForwardActivationSuccessorAdmission(prior, {
      failedActivationBytes: history.failedForwardActivation,
      failedForwardBytes: history.failedForward,
      failedUpgradeBytes: history.failedUpgrade,
      originalPredecessorBytes: history.original,
      productMigrationProof,
      now: historicalOperationNow(prior),
    });
    // Authenticate the unchanged older chain using its own baseline; the new
    // mixed baseline is separately bound to the producer bytes and live guards.
    validateForwardAdmission(
      { ...common, kind: "platform-upgrade-forward-recovery", baseline: prior.baseline },
      {
        failedBytes: history.failedUpgrade,
        originalPredecessorBytes: history.original,
        productMigrationProof,
        now,
      },
    );
    for (const key of [
      "failed",
      "originalPredecessor",
      "oldConfigurationSha256",
      "failedConfigurationSha256",
      "candidateConfigurationSha256",
    ])
      same(value[key], prior[key]);
    for (const key of ["admission", "target", "configurationSha256"])
      same(value.identity[key], prior.identity[key]);
    same(value.baseline.schema, prior.baseline.schema);
    same(value.baseline.productMigrationProofSha256, prior.baseline.productMigrationProofSha256);
    ensure(
      value.identity.operationId !== prior.identity.operationId &&
        value.identity.executorSha !== prior.identity.executorSha &&
        value.dispatch.runId !== prior.dispatch.runId &&
        value.dispatch.runId !== s.decision.dispatch.runId &&
        value.executorCi.runId !== prior.executorCi.runId,
    );
    ensure(
      failedEdgeBytes.prepareConsumption.equals(encode(forwardPhaseReceipt(prior))) &&
        failedEdgeBytes.activateConsumption.equals(encode(forwardPhaseReceipt(s.decision))),
    );
    ensure(failedEdgeBytes.predecessorIndex.equals(history.failedForwardActivation.index));
    same(r.index, {
      version: 1,
      kind: "platform-forward-recovery-index",
      operationId: prior.identity.operationId,
      stateSha256: digest(failedEdgeBytes.state),
      predecessorIndexSha256: prior.priorActivation.hashes.index,
      admissionSha256: digest(encode(prior)),
    });
    const inherited = JSON.parse(history.failedForwardActivation.prepareOperation);
    const historicalSources = {
      ...inherited.historicalSources,
      priorActivationReceiptSha256: prior.priorActivation.hashes.installedExecutor,
    };
    envelope(
      r.prepareOperation,
      "post-migration-prepare",
      prior,
      s.decision,
      observation.root,
      historicalSources,
      inherited.observationPolicy,
    );
    envelope(
      r.activationOperation,
      "post-migration-activate",
      prior,
      s.decision,
      observation.root,
      historicalSources,
      inherited.observationPolicy,
    );
    same(r.prepareOperation.operation.configuration, r.activationOperation.operation.configuration);
    markers(r, "prepare", "post-migration-prepare", prior.dispatch, prior);
    markers(r, "activation", "post-migration-activate", s.decision.dispatch, prior);
    same(r.installedExecutor.ci, prior.executorCi);
    same(r.installedExecutor.installationDispatch, prior.dispatch);
    const backup = runtime(r.backupRuntime);
    ensure(
      backup.executorSha === prior.identity.executorSha &&
        backup.provenance === "live-source" &&
        backup.dockerExecutable === "/usr/bin/docker" &&
        backup.endpoint === "unix:///var/run/docker.sock",
    );
    validateForwardRetained(r.retainedRuntime, prior);
    const intent = r.handoffIntent,
      success = r.handoffSuccess;
    same(intent, {
      version: 1,
      kind: "platform-forward-index-handoff",
      operationId: prior.identity.operationId,
      failedOperationId: prior.priorActivation.identity.operationId,
      expectedSha256: prior.priorActivation.hashes.index,
      originalMetadata: intent.originalMetadata,
      admissionSha256: digest(encode(prior)),
    });
    same(success, {
      version: 1,
      kind: "platform-forward-index-handoff-completed",
      operationId: prior.identity.operationId,
      archivedSha256: prior.priorActivation.hashes.index,
      originalMetadata: intent.originalMetadata,
      archivedMetadata: observation.predecessorMetadata,
      intentSha256: digest(failedEdgeBytes.handoffIntent),
    });
    validatePreservedForwardMetadata(intent.originalMetadata, success.archivedMetadata);
    same(r.failure, {
      version: 1,
      kind: "platform-host-failure",
      operationId: prior.identity.operationId,
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
    const source = r.sourceObservation;
    keys(source, [
      "version",
      "kind",
      "operationId",
      "stateSha256",
      "target",
      "configurationSha256",
      "observedAt",
      "schema",
      "productMigrationProofSha256",
      "containers",
    ]);
    ensure(
      source.version === 1 &&
        source.kind === "platform-forward-edge-source" &&
        source.operationId === prior.identity.operationId &&
        source.stateSha256 === digest(failedEdgeBytes.state) &&
        source.configurationSha256 === prior.candidateConfigurationSha256,
    );
    same(source.target, prior.identity.target);
    same(source.schema, prior.baseline.schema);
    same(source.productMigrationProofSha256, prior.baseline.productMigrationProofSha256);
    ensure(
      timestamp(source.observedAt) <= now &&
        timestamp(source.observedAt) >= timestamp(s.decision.expiresAt) &&
        timestamp(source.observedAt) >=
          Math.ceil(Number(observation.stateMetadata.mtimeNs) / 1000000),
    );
    keys(source.containers, ["postgres", "api", "edge"]);
    keys(value.baseline.containers, ["postgres", "api", "edge"]);
    for (const service of ["postgres", "api", "edge"]) {
      const c = source.containers[service];
      keys(c, [
        "id",
        "imageId",
        "reference",
        "running",
        "paused",
        "restarting",
        "status",
        "health",
        "exitCode",
      ]);
      ensure(
        hash(c.id) &&
          c.id === value.baseline.containers[service] &&
          c.paused === false &&
          c.restarting === false,
      );
      if (service === "postgres")
        ensure(
          c.id === prior.baseline.containers.postgres &&
            c.imageId === r.retainedRuntime.postgresImageId &&
            c.reference === r.retainedRuntime.containers.postgres.Config.Image &&
            c.running === true &&
            c.status === "running" &&
            c.health === "healthy" &&
            c.exitCode === 0,
        );
      else {
        const selected =
          service === "api"
            ? prior.identity.admission.registry.api
            : prior.originalPredecessor.identity.admission.registry.edge;
        ensure(
          c.imageId === selected.imageId &&
            c.reference === selected.reference &&
            c.running === false &&
            c.status === "exited" &&
            c.health === null &&
            c.exitCode === 0,
        );
        ensure(
          service === "api"
            ? !Object.values(prior.baseline.containers).includes(c.id)
            : c.id === prior.baseline.containers.edge,
        );
      }
    }
    ensure(new Set(Object.values(value.baseline.containers)).size === 3);
    return value;
  } catch {
    throw refusal();
  }
}
