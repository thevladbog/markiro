import { dirname } from "node:path";
import { canonical, ensure, hash, keys } from "../backup/schemas.mjs";
import { canonicalId } from "../release-admission.mjs";
import { validateUpgradeAuthorization, validateUpgradeDispatch } from "../upgrade-dispatch.mjs";
import { activationHash, snapshotActivation } from "./recovery-activation-admission.mjs";
import { validateIdentity, validateBackup, sameTarget } from "./state-validation.mjs";
import { validateUpgradeAdmission } from "./upgrade-admission.mjs";
import {
  validateUpgradeJournal,
  validateUpgradePhaseAdmission,
  upgradePhaseReceipt,
} from "./upgrade-phase-admission.mjs";
import { validateUpgradeSchema } from "./upgrade-proofs.mjs";
import { validateProductMigrationLedger } from "./forward-ledger.mjs";
import { readPrivateFile } from "./files.mjs";

export const failedUpgradeNames = Object.freeze([
  "state",
  "beforeActivate",
  "prepareConsumption",
  "activateConsumption",
  "prepareOperation",
  "activateOperation",
  "index",
]);
const same = (a, b) => ensure(canonical(a) === canonical(b));
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const expiry = (value, now) => {
  const end = Date.parse(value);
  ensure(
    typeof value === "string" &&
      Number.isSafeInteger(now) &&
      Number.isSafeInteger(end) &&
      new Date(end).toISOString() === value &&
      end > now &&
      end - now <= 3600000,
  );
};
function ci(value) {
  keys(value, ["runId", "runAttempt"]);
  ensure(canonicalId(value.runId) && value.runAttempt === "1");
}
function refusal(error) {
  const result = new Error("Post-migration forward recovery admission rejected.");
  result.code = "ERR_HOST_FORWARD_ADMISSION";
  // No raw input, nested exception or private operation bytes leave admission.
  if (error?.durabilityUncertain === true) result.durabilityUncertain = true;
  return result;
}
export async function readFailedUpgradePredecessor(root, oldOperationId) {
  try {
    ensure(uuid(oldOperationId));
    const prefix = `upgrade-operations/${oldOperationId}`;
    const result = {};
    for (const [key, path] of [
      ["state", `${prefix}/state.json`],
      ["beforeActivate", `${prefix}/before-activate.json`],
      ["prepareConsumption", `${prefix}/prepare-consumption.json`],
      ["activateConsumption", `${prefix}/activate-consumption.json`],
      ["index", "upgrade-index.json"],
    ])
      result[key] = await readPrivateFile(root, path);
    for (const phase of ["prepare", "activate"])
      result[`${phase}Operation`] = await readPrivateFile(
        dirname(root),
        `${prefix}/${phase}/operation.json`,
      );
    return result;
  } catch (error) {
    throw refusal(error);
  }
}
export function validateForwardAdmission(
  input,
  { failedBytes, originalPredecessorBytes, productMigrationProof, now },
) {
  try {
    const value = snapshotActivation(input);
    keys(value, [
      "version",
      "kind",
      "phase",
      "identity",
      "failed",
      "originalPredecessor",
      "oldConfigurationSha256",
      "failedConfigurationSha256",
      "candidateConfigurationSha256",
      "baseline",
      "executorCi",
      "dispatch",
      "reviewedPlanSha256",
      "expiresAt",
    ]);
    ensure(
      value.version === 1 &&
        value.kind === "platform-upgrade-forward-recovery" &&
        value.phase === "post-migration-prepare",
    );
    validateIdentity(value.identity);
    keys(value.failed, ["identity", "hashes"]);
    validateIdentity(value.failed.identity);
    keys(value.failed.hashes, failedUpgradeNames);
    keys(failedBytes, failedUpgradeNames);
    const records = {};
    for (const name of failedUpgradeNames) {
      const bytes = failedBytes[name];
      ensure(
        Buffer.isBuffer(bytes) &&
          bytes.length > 0 &&
          bytes.length <= 1048576 &&
          hash(value.failed.hashes[name]) &&
          activationHash(bytes) === value.failed.hashes[name],
      );
      records[name] = snapshotActivation(JSON.parse(bytes.toString("utf8")));
    }
    const { state, beforeActivate: prior, prepareOperation, activateOperation } = records;
    validateUpgradeAdmission(state.admission, {
      predecessorBytes: originalPredecessorBytes,
      now: Date.parse(state.admission.expiresAt) - 1,
    });
    validateUpgradeJournal(prior);
    validateUpgradePhaseAdmission(state.decision, {
      prior,
      priorBytes: failedBytes.beforeActivate,
      now: Date.parse(state.decision.expiresAt) - 1,
    });
    validateUpgradeJournal(state, prior);
    ensure(
      state.sequence === 14 &&
        state.phase === "api-started" &&
        state.status === "recovery-required" &&
        state.migrationEntered === true &&
        state.decision.phase === "activate",
    );
    same(value.failed.identity, state.admission.identity);
    same(value.originalPredecessor, state.admission.predecessor);
    ensure(
      failedBytes.prepareConsumption.equals(
        encode({
          version: 1,
          kind: "platform-upgrade-prepare-consumption",
          operationId: state.admission.identity.operationId,
          admissionSha256: activationHash(encode(state.admission)),
          dispatch: state.admission.dispatch,
        }),
      ),
    );
    ensure(failedBytes.activateConsumption.equals(encode(upgradePhaseReceipt(state.decision))));
    same(records.index, {
      version: 1,
      kind: "platform-upgrade-index",
      operationId: state.admission.identity.operationId,
      stateSha256: activationHash(failedBytes.state),
    });
    const originalOperation = JSON.parse(originalPredecessorBytes.activationOperation);
    for (const [record, phase] of [
      [prepareOperation, "prepare"],
      [activateOperation, "activate"],
    ]) {
      keys(record, [
        "version",
        "kind",
        "phase",
        "installedRoot",
        "dispatch",
        "authorization",
        "operation",
        "observationPolicy",
      ]);
      ensure(
        record.version === 1 &&
          record.kind === "platform-upgrade-host-operation" &&
          record.phase === phase,
      );
      validateUpgradeAuthorization(record.authorization);
      validateUpgradeDispatch(record.dispatch);
      ensure(
        record.installedRoot ===
          `${dirname(record.operation.root)}/upgrade-bootstrap/${state.admission.identity.executorSha}`,
      );
      same(
        record.dispatch,
        phase === "prepare" ? state.admission.dispatch : state.decision.dispatch,
      );
      same(record.observationPolicy, originalOperation.observationPolicy);
      const op = record.operation;
      keys(op, [
        "root",
        "dockerConfig",
        "admission",
        "configuration",
        "predecessorContainers",
        ...(phase === "prepare"
          ? ["connectionFile", "roleMapping"]
          : ["decision", "preparedTarget", "preparedPolicy"]),
      ]);
      ensure(
        op.root === originalOperation.operation.root &&
          op.dockerConfig === `${op.root}/docker` &&
          uuid(op.configuration.candidateId),
      );
      same(op.admission, state.admission);
      same(op.predecessorContainers, state.oldRuntime.containers);
      if (phase === "prepare") {
        ensure(
          typeof op.connectionFile === "string" && op.connectionFile.startsWith(`${op.root}/`),
        );
        keys(op.roleMapping, ["version", "roles", "allowedDeltas"]);
        ensure(
          op.roleMapping.version === 1 &&
            Array.isArray(op.roleMapping.roles) &&
            Array.isArray(op.roleMapping.allowedDeltas),
        );
      } else {
        same(op.decision, state.decision);
        ensure(
          op.preparedTarget.version === 2 &&
            op.preparedTarget.provenance === "live-source" &&
            op.preparedPolicy.provenance === "live-source",
        );
        for (const k of ["operationId", "executorSha", "configurationSha256", "target"])
          same(op.preparedTarget[k], state.admission.identity[k]);
        same(op.preparedTarget.fence, prior.preparation.fence);
      }
    }
    same(prepareOperation.operation.configuration, activateOperation.operation.configuration);
    const old = state.admission;
    ensure(
      value.identity.executorSha !== old.identity.executorSha &&
        ![
          old.identity.operationId,
          old.predecessor.identity.operationId,
          JSON.parse(originalPredecessorBytes.original).current.identity.operationId,
        ].includes(value.identity.operationId),
    );
    same(value.identity.admission, old.identity.admission);
    ensure(sameTarget(value.identity.target, old.identity.target));
    ensure(
      value.oldConfigurationSha256 === old.oldConfigurationSha256 &&
        value.failedConfigurationSha256 === old.candidateConfigurationSha256 &&
        value.candidateConfigurationSha256 === value.identity.configurationSha256,
    );
    keys(value.baseline, ["containers", "schema", "productMigrationProofSha256"]);
    same(value.baseline.containers, state.oldRuntime.containers);
    validateUpgradeSchema(value.baseline.schema, value.identity);
    // The proof must be minted by extraction, never an operator JSON claim.
    validateProductMigrationLedger(
      productMigrationProof.entries.map(({ hash, createdAt }) => ({ hash, createdAt })),
      productMigrationProof,
    );
    ensure(
      value.baseline.schema.migrationCount === String(productMigrationProof.entries.length) &&
        value.baseline.productMigrationProofSha256 === productMigrationProof.proofSha256 &&
        productMigrationProof.productSha === value.identity.admission.manifest.sourceSha &&
        productMigrationProof.imageId === value.identity.admission.registry.api.imageId &&
        productMigrationProof.imageReference === value.identity.admission.manifest.api,
    );
    ci(value.executorCi);
    validateUpgradeDispatch(value.dispatch);
    ensure(
      value.dispatch.toolingSha === value.identity.executorSha &&
        ![
          old.dispatch.runId,
          state.decision.dispatch.runId,
          originalOperation.dispatch.runId,
        ].includes(value.dispatch.runId) &&
        value.executorCi.runId !== old.executorCi.runId &&
        hash(value.reviewedPlanSha256),
    );
    expiry(value.expiresAt, now);
    return value;
  } catch (error) {
    throw refusal(error);
  }
}
export function validateForwardDecision(input, { priorBytes, prior, now }) {
  try {
    const value = snapshotActivation(input);
    keys(value, [
      "version",
      "kind",
      "phase",
      "identity",
      "prior",
      "executorCi",
      "reviewedPlanSha256",
      "dispatch",
      "expiresAt",
    ]);
    ensure(
      value.version === 1 &&
        value.kind === "platform-forward-recovery-phase" &&
        value.phase === "post-migration-activate",
    );
    validateIdentity(value.identity);
    ensure(Buffer.isBuffer(priorBytes) && priorBytes.length > 0 && priorBytes.length <= 1048576);
    same(JSON.parse(priorBytes), prior);
    keys(value.prior, ["sequence", "sha256"]);
    ensure(
      prior.version === 1 &&
        prior.admission.kind === "platform-upgrade-forward-recovery" &&
        prior.admission.phase === "post-migration-prepare" &&
        !prior.decision &&
        prior.sequence === 6 &&
        prior.phase === "backup-verified" &&
        prior.status === "completed" &&
        prior.migrationEntered === true &&
        prior.sourceRuntime &&
        prior.preparation &&
        prior.backup,
    );
    validateBackup(prior.backup, value.identity);
    ensure(
      value.prior.sequence === prior.sequence && value.prior.sha256 === activationHash(priorBytes),
    );
    for (const k of ["identity", "executorCi", "reviewedPlanSha256"])
      same(value[k], prior.admission[k]);
    ci(value.executorCi);
    validateUpgradeDispatch(value.dispatch);
    ensure(
      value.dispatch.toolingSha === value.identity.executorSha &&
        value.dispatch.runId !== prior.admission.dispatch.runId &&
        hash(value.reviewedPlanSha256),
    );
    expiry(value.expiresAt, now);
    return value;
  } catch (error) {
    throw refusal(error);
  }
}
