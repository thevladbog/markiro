import { canonical, ensure, keys, hash } from "../backup/schemas.mjs";
import { canonicalId } from "../release-admission.mjs";
import { snapshotActivation, activationHash } from "./recovery-activation-admission.mjs";
import { validateOldRuntime, validateUpgradePreparation } from "./upgrade-proofs.mjs";
import { validateBackup } from "./state-validation.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
export const upgradePhaseGraphs = Object.freeze({
  prepare: Object.freeze(["admitted", "old-stopped", "backup-verified"]),
  activate: Object.freeze([
    "activation-admitted",
    "migration-entered",
    "migrated",
    "api-started",
    "edge-started",
    "healthy",
  ]),
  "return-old": Object.freeze([
    "return-admitted",
    "old-api-started",
    "old-edge-started",
    "returned-old",
  ]),
});
const encode = (v) => Buffer.from(JSON.stringify(v) + "\n");

// Caller verifies the archived chain and historical predecessor before using
// this shape. No journal is accepted by sequence alone.
export function validateUpgradeJournal(input, prior = null) {
  const s = snapshotActivation(input);
  keys(s, [
    "version",
    "admission",
    "sequence",
    "phase",
    "status",
    "backup",
    "oldRuntime",
    "preparation",
    "migrationEntered",
    ...(prior ? ["decision"] : []),
  ]);
  ensure(s.version === 1 && Number.isSafeInteger(s.sequence));
  ensure(["entered", "completed", "recovery-required"].includes(s.status));
  const mode = prior ? s.decision.phase : "prepare";
  const graph = upgradePhaseGraphs[mode];
  ensure(graph);
  const i = graph.indexOf(s.phase);
  ensure(i >= 0);
  const entered = (prior ? prior.sequence : 0) + 1 + 2 * i;
  ensure(
    s.status === "entered"
      ? s.sequence === entered
      : s.status === "completed"
        ? s.sequence === entered + 1
        : [entered + 1, entered + 2].includes(s.sequence),
  );
  ensure(s.migrationEntered === (mode === "activate" && i >= 1));
  if (s.oldRuntime) validateOldRuntime(s.oldRuntime, s.admission);
  if (s.backup) validateBackup(s.backup, s.admission.identity);
  if (s.preparation) validateUpgradePreparation(s.preparation, s.admission, s.oldRuntime, s.backup);
  if (prior) {
    for (const k of ["admission", "backup", "oldRuntime", "preparation"]) same(s[k], prior[k]);
  } else {
    if (i > 0 || s.status === "completed") ensure(s.oldRuntime);
    if (i < 2 || s.status === "entered") ensure(s.backup === null && s.preparation === null);
    if (i === 2 && s.status === "completed") ensure(s.backup && s.preparation);
    ensure((s.backup === null) === (s.preparation === null));
  }
  return s;
}

export function validateUpgradePhaseAdmission(input, { priorBytes, prior, now }) {
  const a = snapshotActivation(input);
  keys(a, [
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
    a.version === 1 &&
      a.kind === "platform-upgrade-phase" &&
      ["activate", "return-old"].includes(a.phase),
  );
  ensure(Buffer.isBuffer(priorBytes) && priorBytes.length > 0 && priorBytes.length <= 1048576);
  same(JSON.parse(priorBytes), prior);
  keys(a.prior, ["sequence", "sha256"]);
  ensure(
    a.prior.sequence === prior.sequence &&
      hash(a.prior.sha256) &&
      a.prior.sha256 === activationHash(priorBytes),
  );
  const base = prior.admission;
  for (const k of ["identity", "executorCi", "reviewedPlanSha256"]) same(a[k], base[k]);
  keys(a.dispatch, ["toolingSha", "runId", "runAttempt"]);
  ensure(
    a.dispatch.toolingSha === a.identity.executorSha &&
      canonicalId(a.dispatch.runId) &&
      canonicalId(a.dispatch.runAttempt),
  );
  ensure(
    a.dispatch.runId !== base.dispatch.runId && a.dispatch.runId !== prior.decision?.dispatch.runId,
  );
  const expiry = Date.parse(a.expiresAt);
  ensure(
    Number.isSafeInteger(now) &&
      Number.isSafeInteger(expiry) &&
      new Date(expiry).toISOString() === a.expiresAt &&
      expiry > now &&
      expiry - now <= 3600000,
  );
  ensure(prior.migrationEntered === false && prior.oldRuntime);
  if (a.phase === "activate")
    ensure(
      !prior.decision &&
        prior.sequence === 6 &&
        prior.phase === "backup-verified" &&
        prior.status === "completed" &&
        prior.preparation &&
        prior.backup,
    );
  else
    ensure(
      (!prior.decision &&
        (prior.status === "recovery-required" ||
          (prior.phase === "backup-verified" && prior.status === "completed"))) ||
        (prior.decision?.phase === "activate" &&
          prior.phase === "activation-admitted" &&
          prior.status === "recovery-required"),
    );
  return a;
}
export const upgradePhaseReceipt = (admission) => ({
  version: 1,
  kind: "platform-upgrade-phase-consumption",
  operationId: admission.identity.operationId,
  phase: admission.phase,
  priorSha256: admission.prior.sha256,
  admissionSha256: activationHash(encode(admission)),
  dispatch: admission.dispatch,
});
