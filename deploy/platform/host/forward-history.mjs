import { ensure } from "../backup/schemas.mjs";
import { readPrivateFile } from "./files.mjs";
import { readUpgradePredecessor } from "./upgrade-state.mjs";
import { validateForwardAdmission, readFailedUpgradePredecessor } from "./forward-admission.mjs";
import {
  validateForwardSuccessorAdmission,
  readFailedForwardPredecessor,
} from "./forward-successor-admission.mjs";
import {
  readFailedForwardActivationPredecessor,
  validateForwardActivationSuccessorAdmission,
} from "./forward-activation-successor-admission.mjs";
export async function readForwardHistory(root, admission, { ownIndexArchive = false } = {}) {
  ensure(typeof ownIndexArchive === "boolean");
  const activationSuccessor = admission.kind === "platform-forward-activation-successor";
  const successor = admission.kind === "platform-forward-admission-successor";
  ensure(
    activationSuccessor || successor || admission.kind === "platform-upgrade-forward-recovery",
  );
  const original = await readUpgradePredecessor(root, admission.originalPredecessor.identity);
  const failedUpgrade = await readFailedUpgradePredecessor(
    root,
    admission.failed.identity.operationId,
  );
  let failedForward = null,
    failedForwardActivation = null;
  if (activationSuccessor) {
    failedForwardActivation = await readFailedForwardActivationPredecessor(
      root,
      admission.priorActivation.identity.operationId,
      ownIndexArchive
        ? { successorOperationId: admission.identity.operationId, indexFromSuccessorArchive: true }
        : {},
    );
    const preceding = JSON.parse(failedForwardActivation.state).admission;
    failedForward = await readFailedForwardPredecessor(
      root,
      preceding.priorForward.identity.operationId,
      { successorOperationId: preceding.identity.operationId, indexFromSuccessorArchive: true },
    );
    failedUpgrade.index = failedForward.predecessorIndex;
  } else if (successor) {
    failedForward = await readFailedForwardPredecessor(
      root,
      admission.priorForward.identity.operationId,
      ownIndexArchive
        ? { successorOperationId: admission.identity.operationId, indexFromSuccessorArchive: true }
        : {},
    );
    failedUpgrade.index = failedForward.predecessorIndex;
  } else if (ownIndexArchive) {
    failedUpgrade.index = await readPrivateFile(
      root,
      `forward-recovery-operations/${admission.identity.operationId}/predecessor-index.json`,
    );
  }
  return {
    original,
    failedUpgrade,
    failedForward,
    ...(activationSuccessor ? { failedForwardActivation } : {}),
    immediateIndex: failedForwardActivation?.index ?? failedForward?.index ?? failedUpgrade.index,
  };
}

export function forwardImmediatePredecessor(admission) {
  ensure(
    [
      "platform-upgrade-forward-recovery",
      "platform-forward-admission-successor",
      "platform-forward-activation-successor",
    ].includes(admission.kind),
  );
  if (admission.kind === "platform-forward-activation-successor") return admission.priorActivation;
  return admission.kind === "platform-forward-admission-successor"
    ? admission.priorForward
    : admission.failed;
}
export function validateForwardHistory(admission, history, { productMigrationProof, now }) {
  if (admission.kind === "platform-forward-activation-successor")
    return validateForwardActivationSuccessorAdmission(admission, {
      failedActivationBytes: history.failedForwardActivation,
      failedForwardBytes: history.failedForward,
      failedUpgradeBytes: history.failedUpgrade,
      originalPredecessorBytes: history.original,
      productMigrationProof,
      now,
    });
  if (admission.kind === "platform-forward-admission-successor")
    return validateForwardSuccessorAdmission(admission, {
      failedForwardBytes: history.failedForward,
      failedUpgradeBytes: history.failedUpgrade,
      originalPredecessorBytes: history.original,
      productMigrationProof,
      now,
    });
  ensure(admission.kind === "platform-upgrade-forward-recovery" && history.failedForward === null);
  return validateForwardAdmission(admission, {
    failedBytes: history.failedUpgrade,
    originalPredecessorBytes: history.original,
    productMigrationProof,
    now,
  });
}
