import { createHash } from "node:crypto";
import { canonical } from "../backup/schemas.mjs";
import { canonicalId, exactKeys } from "../release-admission.mjs";
import { snapshot, stateError, validateBackup } from "./state-validation.mjs";
import { validateRecoveryAdmission } from "./recovery-admission.mjs";

export const activationHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireValid = (value) => {
  if (!value) throw stateError();
};
const same = (a, b) => requireValid(canonical(a) === canonical(b));
const names = [
  "postgres",
  "tls",
  "rolePolicy",
  "restoredSnapshot",
  "egress",
  "keyContinuity",
  "offHostRecovery",
];

// Unlike the journal snapshot, prepared evidence contains arrays. Inspect every
// descriptor before reading it, including array entries, then freeze the copy.
export function snapshotActivation(value, depth = 0) {
  requireValid(depth < 20);
  if (value === null || typeof value !== "object") return snapshot(value);
  let result;
  if (Array.isArray(value)) {
    requireValid(Object.getPrototypeOf(value) === Array.prototype);
    requireValid(Reflect.ownKeys(value).length === value.length + 1);
    result = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      requireValid(descriptor?.enumerable && Object.hasOwn(descriptor, "value"));
      result.push(snapshotActivation(descriptor.value, depth + 1));
    }
  } else {
    requireValid([Object.prototype, null].includes(Object.getPrototypeOf(value)));
    result = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireValid(
        typeof key === "string" &&
          key !== "__proto__" &&
          descriptor.enumerable &&
          Object.hasOwn(descriptor, "value"),
      );
      result[key] = snapshotActivation(descriptor.value, depth + 1);
    }
  }
  return Object.freeze(result);
}

// This is structural admission only. A later trusted delivery must verify GitHub
// dispatch and pinned executor CI. A later executor MUST call validatePreparedTarget
// with actual archived backup/configuration and live observers before workloads.
export function validateRecoveryActivationAdmission(input, { stateBytes, preparationBytes, now }) {
  const value = snapshotActivation(input);
  requireValid(
    exactKeys(value, [
      "version",
      "kind",
      "admission",
      "preparation",
      "preparedTarget",
      "preparedPolicy",
      "configuration",
      "dispatch",
    ]),
  );
  requireValid(value.version === 1 && value.kind === "platform-recovery-activation");
  requireValid(
    Buffer.isBuffer(preparationBytes) &&
      preparationBytes.length > 0 &&
      preparationBytes.length <= 1048576,
  );
  const admission = validateRecoveryAdmission(value.admission, { stateBytes, now });
  const preparation = snapshot(JSON.parse(preparationBytes.toString("utf8")));
  requireValid(
    exactKeys(preparation, ["version", "admission", "sequence", "phase", "status", "backup"]),
  );
  requireValid(
    preparation.version === 1 &&
      preparation.sequence === 6 &&
      preparation.phase === "backup-verified" &&
      preparation.status === "completed",
  );
  // Historical stage1 expiry is schema-checked at its own bounded admission time,
  // never reused as current authorization. Fresh admission alone gates this stage.
  const historicalExpiry = Date.parse(preparation.admission.expiresAt);
  validateRecoveryAdmission(preparation.admission, { stateBytes, now: historicalExpiry - 1 });
  for (const key of ["identity", "predecessor", "executorCi"])
    same(preparation.admission[key], admission[key]);
  validateBackup(preparation.backup, admission.identity);
  requireValid(exactKeys(value.preparation, ["sequence", "sha256"]));
  requireValid(
    value.preparation.sequence === 6 &&
      value.preparation.sha256 === activationHash(preparationBytes),
  );
  requireValid(exactKeys(value.dispatch, ["toolingSha", "runId", "runAttempt"]));
  requireValid(
    typeof value.dispatch.toolingSha === "string" &&
      /^[a-f0-9]{40}$/u.test(value.dispatch.toolingSha) &&
      canonicalId(value.dispatch.runId) &&
      canonicalId(value.dispatch.runAttempt),
  );
  requireValid(
    exactKeys(value.configuration, ["candidateId", "runtimeSnapshot", "migrationSnapshot"]),
  );
  const policy = value.preparedPolicy,
    target = value.preparedTarget;
  requireValid(
    exactKeys(policy, [
      "backup",
      "restoreEvidence",
      "roleMapping",
      "postgres",
      "tls",
      "rolePolicySha256",
      "provenance",
      "maxAgeMs",
      "producers",
    ]),
  );
  requireValid(
    policy.provenance === "live-source" &&
      Number.isSafeInteger(policy.maxAgeMs) &&
      policy.maxAgeMs > 0 &&
      policy.maxAgeMs <= 86400000,
  );
  requireValid(exactKeys(policy.producers, names));
  requireValid(
    exactKeys(target, [
      "version",
      "kind",
      "operationId",
      "target",
      "executorSha",
      "provenance",
      "configurationSha256",
      "fence",
      "observations",
    ]),
  );
  requireValid(
    target.version === 2 &&
      target.kind === "platform-prepared-target" &&
      target.provenance === "live-source",
  );
  for (const key of ["operationId", "target", "executorSha", "configurationSha256"])
    same(target[key], admission.identity[key]);
  requireValid(exactKeys(target.fence, ["fenceId", "enforcementSha256", "beganAt"]));
  requireValid(exactKeys(target.observations, names));
  for (const name of names) {
    const observation = target.observations[name];
    requireValid(
      exactKeys(observation, [
        "kind",
        "producerId",
        "executorSha",
        "operationId",
        "target",
        "fenceId",
        "configurationSha256",
        "snapshotId",
        "observedAt",
        "value",
      ]),
    );
    for (const key of ["operationId", "target", "executorSha", "configurationSha256"])
      same(observation[key], admission.identity[key]);
    same(observation.fenceId, target.fence.fenceId);
    same(observation.producerId, policy.producers[name]);
  }
  const restored = target.observations.restoredSnapshot.value;
  same(restored.archiveSha256, preparation.backup.archiveSha256);
  same(restored.restoreEvidenceSha256, preparation.backup.restoreEvidenceSha256);
  return value;
}
