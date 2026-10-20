import { createHash } from "node:crypto";
import { canonical } from "../backup/schemas.mjs";
import { canonicalId, exactKeys } from "../release-admission.mjs";
import { snapshot, validateIdentity, validateState } from "./state-validation.mjs";

function refusal() {
  const error = new Error("Failed activation recovery admission rejected.");
  error.code = "ERR_HOST_RECOVERY_ADMISSION";
  return error;
}
const requireValid = (value) => {
  if (!value) throw refusal();
};

// Structural admission only: the delivery boundary must independently verify
// exact-main CI, installed executor bytes and actual target ownership.
export function validateRecoveryAdmission(input, { stateBytes, now }) {
  try {
    requireValid(
      Buffer.isBuffer(stateBytes) && stateBytes.length > 0 && stateBytes.length <= 1048576,
    );
    requireValid(Number.isSafeInteger(now));
    const value = snapshot(input);
    requireValid(
      exactKeys(value, ["version", "kind", "identity", "predecessor", "executorCi", "expiresAt"]),
    );
    requireValid(value.version === 1 && value.kind === "platform-failed-activation-recovery");
    validateIdentity(value.identity);
    requireValid(exactKeys(value.predecessor, ["identity", "sequence", "stateSha256"]));
    validateIdentity(value.predecessor.identity);
    requireValid(exactKeys(value.executorCi, ["runId", "runAttempt"]));
    requireValid(canonicalId(value.executorCi.runId) && canonicalId(value.executorCi.runAttempt));
    requireValid(typeof value.expiresAt === "string");
    const expiry = Date.parse(value.expiresAt);
    requireValid(Number.isFinite(expiry) && new Date(expiry).toISOString() === value.expiresAt);
    requireValid(expiry > now && expiry - now <= 3600000);
    requireValid(
      createHash("sha256").update(stateBytes).digest("hex") === value.predecessor.stateSha256,
    );
    const state = validateState(JSON.parse(stateBytes.toString("utf8")));
    requireValid(state.sequence === 14 && value.predecessor.sequence === state.sequence);
    requireValid(
      state.previousHealthy === null &&
        state.current?.phase === "api-started" &&
        state.current.status === "recovery-required",
    );
    requireValid(canonical(state.current.identity) === canonical(value.predecessor.identity));
    const previous = state.current.identity;
    requireValid(value.identity.operationId !== previous.operationId);
    requireValid(value.identity.configurationSha256 === previous.configurationSha256);
    requireValid(canonical(value.identity.target) === canonical(previous.target));
    requireValid(canonical(value.identity.admission) === canonical(previous.admission));
    return value;
  } catch {
    throw refusal();
  }
}
