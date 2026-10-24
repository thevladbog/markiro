import { canonical } from "../backup/schemas.mjs";
import { canonicalId, exactKeys } from "../release-admission.mjs";
import { validateIdentity, sameTarget } from "./state-validation.mjs";
import {
  activationHash,
  snapshotActivation,
  validateRecoveryActivationAdmission,
} from "./recovery-activation-admission.mjs";

export const predecessorNames = Object.freeze([
  "original",
  "acceptedRecovery",
  "preparation",
  "consumption",
  "activationOperation",
]);
function refusal() {
  const error = new Error("Accepted recovery upgrade admission rejected.");
  error.code = "ERR_HOST_UPGRADE_ADMISSION";
  return error;
}
const ensure = (value) => {
  if (!value) throw refusal();
};
const same = (a, b) => ensure(canonical(a) === canonical(b));
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
function run(value, dispatch = false) {
  ensure(
    exactKeys(value, dispatch ? ["toolingSha", "runId", "runAttempt"] : ["runId", "runAttempt"]),
  );
  ensure(canonicalId(value.runId) && canonicalId(value.runAttempt));
  if (dispatch) ensure(sha(value.toolingSha));
}

// Structural admission only. Exact-main CI, protected dispatch approval, source
// closure and actual configuration/target observations belong to trusted delivery.
// Old expiry authenticates a historical shape; it never authorizes new work.
export function validateUpgradeAdmission(input, { predecessorBytes, now }) {
  try {
    const value = snapshotActivation(input);
    ensure(
      exactKeys(value, [
        "version",
        "kind",
        "phase",
        "identity",
        "predecessor",
        "oldConfigurationSha256",
        "candidateConfigurationSha256",
        "executorCi",
        "dispatch",
        "reviewedPlanSha256",
        "expiresAt",
      ]),
    );
    ensure(
      value.version === 1 &&
        value.kind === "platform-accepted-recovery-upgrade" &&
        value.phase === "prepare",
    );
    validateIdentity(value.identity);
    ensure(exactKeys(value.predecessor, ["identity", "hashes"]));
    validateIdentity(value.predecessor.identity);
    ensure(exactKeys(value.predecessor.hashes, predecessorNames));
    ensure(exactKeys(predecessorBytes, predecessorNames));
    const records = {};
    for (const name of predecessorNames) {
      const bytes = predecessorBytes[name];
      ensure(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1048576);
      ensure(
        hash(value.predecessor.hashes[name]) &&
          activationHash(bytes) === value.predecessor.hashes[name],
      );
      records[name] = snapshotActivation(JSON.parse(bytes.toString("utf8")));
    }
    const {
      acceptedRecovery: recovered,
      preparation,
      consumption,
      activationOperation: operation,
    } = records;
    ensure(
      exactKeys(recovered, [
        "version",
        "admission",
        "sequence",
        "phase",
        "status",
        "backup",
        "preparation",
        "activation",
      ]),
    );
    ensure(
      recovered.version === 1 &&
        recovered.sequence === 16 &&
        recovered.phase === "healthy" &&
        recovered.status === "completed",
    );
    const activation = recovered.activation;
    const historicalNow = Date.parse(activation.admission.expiresAt) - 1;
    ensure(Number.isSafeInteger(historicalNow));
    validateRecoveryActivationAdmission(activation, {
      stateBytes: predecessorBytes.original,
      preparationBytes: predecessorBytes.preparation,
      now: historicalNow,
    });
    same(recovered, {
      ...preparation,
      sequence: 16,
      phase: "healthy",
      status: "completed",
      preparation: activation.preparation,
      activation,
    });
    same(value.predecessor.identity, activation.admission.identity);
    same(consumption, {
      version: 1,
      kind: "platform-recovery-activation-consumption",
      operationId: value.predecessor.identity.operationId,
      preparationSha256: activation.preparation.sha256,
      activationSha256: activationHash(Buffer.from(JSON.stringify(activation))),
      dispatch: activation.dispatch,
    });
    ensure(
      exactKeys(operation, [
        "version",
        "kind",
        "phase",
        "installedRoot",
        "dispatch",
        "operation",
        "observationPolicy",
      ]),
    );
    ensure(
      operation.version === 1 &&
        operation.kind === "platform-recovery-host-operation" &&
        operation.phase === "activate",
    );
    ensure(
      operation.installedRoot ===
        `/opt/markiro-platform/recovery-bootstrap/${value.predecessor.identity.executorSha}`,
    );
    ensure(exactKeys(operation.operation, ["root", "dockerConfig", "activation"]));
    ensure(
      typeof operation.operation.root === "string" &&
        operation.operation.root.startsWith("/") &&
        operation.operation.dockerConfig === `${operation.operation.root}/docker`,
    );
    same(operation.dispatch, activation.dispatch);
    same(operation.operation.activation, activation);
    const old = value.predecessor.identity;
    ensure(
      value.identity.operationId !== old.operationId &&
        value.identity.operationId !== records.original.current.identity.operationId,
    );
    ensure(sameTarget(value.identity.target, old.target));
    ensure(
      value.oldConfigurationSha256 === old.configurationSha256 &&
        value.candidateConfigurationSha256 === value.identity.configurationSha256,
    );
    run(value.executorCi);
    run(value.dispatch, true);
    ensure(
      value.dispatch.toolingSha === value.identity.executorSha && hash(value.reviewedPlanSha256),
    );
    ensure(Number.isSafeInteger(now) && typeof value.expiresAt === "string");
    const expiry = Date.parse(value.expiresAt);
    ensure(
      Number.isSafeInteger(expiry) &&
        new Date(expiry).toISOString() === value.expiresAt &&
        expiry > now &&
        expiry - now <= 3600000,
    );
    return value;
  } catch {
    throw refusal();
  }
}
