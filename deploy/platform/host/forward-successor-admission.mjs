import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonical, digest, ensure, hash, keys, runtime } from "../backup/schemas.mjs";
import { validateUpgradeAuthorization, validateUpgradeDispatch } from "../upgrade-dispatch.mjs";
import { readPrivateFile, assertPrivateRootSync } from "./files.mjs";
import { validateForwardAdmission } from "./forward-admission.mjs";
import { validateForwardJournal, forwardPhaseReceipt } from "./forward-state.mjs";
import { activationHash, snapshotActivation } from "./recovery-activation-admission.mjs";
export const failedForwardNames = Object.freeze([
  "state",
  "prepareConsumption",
  "prepareOperation",
  "failure",
  "index",
  "predecessorIndex",
  "handoffIntent",
  "handoffSuccess",
  "installedExecutor",
  "backupRuntime",
  "delivery",
  "executionFence",
  "commandStarted",
]);
const observations = new WeakMap();
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const same = (a, b) => ensure(canonical(a) === canonical(b));
const encode = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
function refusal() {
  const e = new Error("Failed forward predecessor rejected.");
  e.code = "ERR_HOST_FORWARD_ADMISSION";
  return e;
}
async function absent(path) {
  try {
    await lstat(path);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  throw refusal();
}
async function exactDirectory(root, relative, expected) {
  assertPrivateRootSync(join(root, relative));
  same((await readdir(join(root, relative))).sort(), [...expected].sort());
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
export async function readFailedForwardPredecessor(root, operationId, options = {}) {
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
    const dir = `forward-recovery-operations/${operationId}`,
      phase = `upgrade-operations/${operationId}/post-migration-prepare`;
    await exactDirectory(root, dir, [
      "state.json",
      "prepare-consumption.json",
      "predecessor-index.json",
      "handoff-intent.json",
      "handoff-success.json",
    ]);
    await exactDirectory(dirname(root), `upgrade-operations/${operationId}`, [
      "post-migration-prepare",
    ]);
    await exactDirectory(dirname(root), phase, [
      "operation.json",
      "github-token",
      "delivery.json",
      "execution-fence.json",
      "command-started.json",
      "failure.json",
    ]);
    await absent(join(root, `forward-retained-${operationId}.json`));
    const result = {};
    for (const [key, path] of Object.entries({
      state: `${dir}/state.json`,
      prepareConsumption: `${dir}/prepare-consumption.json`,
      index: indexFromSuccessorArchive
        ? `forward-recovery-operations/${successorOperationId}/predecessor-index.json`
        : "upgrade-index.json",
      predecessorIndex: `${dir}/predecessor-index.json`,
      handoffIntent: `${dir}/handoff-intent.json`,
      handoffSuccess: `${dir}/handoff-success.json`,
      installedExecutor: `upgrade-installed-executor-${operationId}.json`,
      backupRuntime: `forward-backup-runtime-${operationId}.json`,
    }))
      result[key] = await readPrivateFile(root, path);
    for (const [key, file] of Object.entries({
      prepareOperation: "operation.json",
      failure: "failure.json",
      delivery: "delivery.json",
      executionFence: "execution-fence.json",
      commandStarted: "command-started.json",
    }))
      result[key] = await readPrivateFile(dirname(root), `${phase}/${file}`);
    observations.set(result, {
      root,
      operationId,
      successorOperationId,
      hashes: Object.fromEntries(failedForwardNames.map((k) => [k, digest(result[k])])),
      predecessorMetadata: await metadata(join(root, dir, "predecessor-index.json")),
    });
    return Object.freeze(result);
  } catch {
    throw refusal();
  }
}
export function validateForwardSuccessorAdmission(
  input,
  { failedForwardBytes, failedUpgradeBytes, originalPredecessorBytes, productMigrationProof, now },
) {
  try {
    const value = snapshotActivation(input),
      observation = observations.get(failedForwardBytes);
    ensure(observation);
    const { priorForward, ...common } = value;
    ensure(value.kind === "platform-forward-admission-successor");
    keys(priorForward, ["identity", "hashes"]);
    keys(priorForward.hashes, failedForwardNames);
    keys(failedForwardBytes, failedForwardNames);
    const records = {};
    for (const name of failedForwardNames) {
      const b = failedForwardBytes[name];
      ensure(
        Buffer.isBuffer(b) &&
          b.length > 0 &&
          b.length <= 1048576 &&
          hash(priorForward.hashes[name]) &&
          digest(b) === priorForward.hashes[name] &&
          digest(b) === observation.hashes[name],
      );
      records[name] = snapshotActivation(JSON.parse(b));
    }
    const { state, prepareOperation: operation } = records,
      prior = state.admission;
    ensure(prior.kind === "platform-upgrade-forward-recovery");
    validateForwardJournal(state);
    ensure(
      state.sequence === 2 &&
        state.phase === "admitted" &&
        state.status === "recovery-required" &&
        state.migrationEntered === true &&
        state.sourceRuntime === null &&
        state.backup === null &&
        state.preparation === null,
    );
    same(priorForward.identity, prior.identity);
    ensure(
      observation.operationId === prior.identity.operationId &&
        (!observation.successorOperationId ||
          observation.successorOperationId === value.identity.operationId),
    );
    ensure(failedUpgradeBytes.index.equals(failedForwardBytes.predecessorIndex));
    validateForwardAdmission(prior, {
      failedBytes: failedUpgradeBytes,
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
        value.identity.executorSha !== prior.identity.executorSha &&
        value.dispatch.runId !== prior.dispatch.runId &&
        value.executorCi.runId !== prior.executorCi.runId,
    );
    ensure(failedForwardBytes.prepareConsumption.equals(encode(forwardPhaseReceipt(prior))));
    same(records.index, {
      version: 1,
      kind: "platform-forward-recovery-index",
      operationId: prior.identity.operationId,
      stateSha256: activationHash(failedForwardBytes.state),
      predecessorIndexSha256: prior.failed.hashes.index,
      admissionSha256: activationHash(encode(prior)),
    });
    keys(operation, [
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
      operation.version === 1 &&
        operation.kind === "platform-forward-recovery-host-operation" &&
        operation.phase === prior.phase &&
        operation.installedRoot ===
          `${dirname(observation.root)}/upgrade-bootstrap/${prior.identity.executorSha}`,
    );
    validateUpgradeAuthorization(operation.authorization);
    validateUpgradeDispatch(operation.dispatch);
    same(operation.dispatch, prior.dispatch);
    keys(operation.historicalSources, ["recoveryReceiptSha256", "failedReceiptSha256"]);
    for (const v of Object.values(operation.historicalSources)) ensure(hash(v));
    same(
      operation.observationPolicy,
      JSON.parse(originalPredecessorBytes.activationOperation).observationPolicy,
    );
    const op = operation.operation;
    keys(op, [
      "root",
      "dockerConfig",
      "admission",
      "configuration",
      "predecessorContainers",
      "connectionFile",
      "roleMapping",
    ]);
    ensure(
      op.root === observation.root &&
        op.dockerConfig === `${op.root}/docker` &&
        typeof op.connectionFile === "string" &&
        op.connectionFile.startsWith(`${op.root}/`),
    );
    same(op.admission, prior);
    same(op.predecessorContainers, prior.baseline.containers);
    keys(op.roleMapping, ["version", "roles", "allowedDeltas"]);
    ensure(
      op.roleMapping.version === 1 &&
        Array.isArray(op.roleMapping.roles) &&
        Array.isArray(op.roleMapping.allowedDeltas),
    );
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
    ensure(
      receipt.files &&
        typeof receipt.files === "object" &&
        !Array.isArray(receipt.files) &&
        Object.keys(receipt.files).length > 0 &&
        Object.keys(receipt.files).length <= 256,
    );
    for (const [path, sha] of Object.entries(receipt.files))
      ensure(
        /^deploy\/[a-zA-Z0-9_./-]+$/u.test(path) &&
          !path.split("/").some((p) => !p || p === "." || p === "..") &&
          hash(sha),
      );
    const config = runtime(records.backupRuntime);
    ensure(
      config.executorSha === prior.identity.executorSha &&
        config.provenance === "live-source" &&
        config.dockerExecutable === "/usr/bin/docker" &&
        config.endpoint === "unix:///var/run/docker.sock",
    );
    const { handoffIntent: intent, handoffSuccess: success } = records;
    keys(intent, [
      "version",
      "kind",
      "operationId",
      "failedOperationId",
      "expectedSha256",
      "originalMetadata",
      "admissionSha256",
    ]);
    ensure(
      intent.version === 1 &&
        intent.kind === "platform-forward-index-handoff" &&
        intent.operationId === prior.identity.operationId &&
        intent.failedOperationId === prior.failed.identity.operationId &&
        intent.expectedSha256 === prior.failed.hashes.index &&
        intent.admissionSha256 === activationHash(encode(prior)),
    );
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
      success.version === 1 &&
        success.kind === "platform-forward-index-handoff-completed" &&
        success.operationId === prior.identity.operationId &&
        success.archivedSha256 === prior.failed.hashes.index &&
        success.intentSha256 === activationHash(failedForwardBytes.handoffIntent),
    );
    same(success.originalMetadata, intent.originalMetadata);
    same(success.archivedMetadata, observation.predecessorMetadata);
    keys(intent.originalMetadata, [
      "dev",
      "ino",
      "uid",
      "gid",
      "mode",
      "size",
      "mtimeNs",
      "ctimeNs",
    ]);
    for (const k of Object.keys(intent.originalMetadata))
      if (k !== "ctimeNs") same(success.archivedMetadata[k], intent.originalMetadata[k]);
    keys(records.delivery, ["phase", "dispatch", "executorSha", "operationId", "bundleSha256"]);
    ensure(hash(records.delivery.bundleSha256));
    for (const record of [records.delivery, records.executionFence, records.commandStarted]) {
      same(record.dispatch, prior.dispatch);
      ensure(
        record.phase === prior.phase &&
          record.executorSha === prior.identity.executorSha &&
          record.operationId === prior.identity.operationId,
      );
    }
    for (const record of [records.executionFence, records.commandStarted]) {
      keys(record, ["version", "phase", "executorSha", "operationId", "dispatch"]);
      ensure(record.version === 1);
    }
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
      ...(Object.hasOwn(failure, "admissionRead") ? ["admissionRead"] : []),
    ]);
    if (Object.hasOwn(failure, "admissionRead")) {
      const read = failure.admissionRead;
      keys(read, ["stage", "reason", "status", "bytesSeen", "limitBytes", "redirectCount"]);
      ensure(
        [
          "publisher",
          "artifact-metadata",
          "artifact-download",
          "artifact-archive",
          "product-ci",
          "executor-ci",
          "publisher-recheck",
        ].includes(read.stage),
      );
      ensure(
        ["validation", "http", "body-limit", "redirect", "timeout", "transport"].includes(
          read.reason,
        ),
      );
      for (const [key, low, high] of [
        ["status", 100, 599],
        ["bytesSeen", 0, 2097153],
        ["redirectCount", 0, 4],
      ])
        ensure(
          read[key] === null ||
            (Number.isSafeInteger(read[key]) && read[key] >= low && read[key] <= high),
        );
      ensure([null, 1048576, 2097152].includes(read.limitBytes));
      // Historical JSON is evidence only, never minted as a new trusted origin.
    }
    ensure(
      failure.version === 1 &&
        failure.kind === "platform-host-failure" &&
        failure.operationId === prior.identity.operationId &&
        failure.phase === "admitted" &&
        failure.boundary === "verifyAdmission" &&
        failure.commandCategory === "validation" &&
        failure.code === "ERR_HOST_FAILURE" &&
        failure.errorName === "Error" &&
        failure.exitStatus === null &&
        failure.executable === null &&
        failure.terminationConfirmed === false &&
        failure.durabilityUncertain === false,
    );
    return value;
  } catch {
    throw refusal();
  }
}
