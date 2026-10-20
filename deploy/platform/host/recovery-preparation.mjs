import { canonical } from "../backup/schemas.mjs";
import { exactKeys } from "../release-admission.mjs";
import { snapshot, stateError } from "./state-validation.mjs";
import { withRecoveryState } from "./recovery-state.mjs";

const methods = [
  "verifyAdmission",
  "inspectTarget",
  "stopOwnedWorkloads",
  "inspectStoppedWorkloads",
  "createBackup",
];
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function requireValid(value) {
  if (!value) throw stateError();
}

// Adapters are trusted installed code, never supplied by operation JSON.
// This stage ends with writers stopped and a newly bound backup proof. It does
// not publish edge, renew activation, or mark the original operation healthy.
export async function executeRecoveryPreparation(input, adapters, options) {
  const context = freeze(snapshot(input));
  requireValid(exactKeys(context, ["root", "admission"]));
  requireValid(methods.every((name) => typeof adapters?.[name] === "function"));
  return withRecoveryState(
    context.root,
    context.admission,
    async (store) => {
      const verified = await adapters.verifyAdmission(context);
      requireValid(canonical(verified) === canonical(context.admission.identity));
      const observed = snapshot(await adapters.inspectTarget(context));
      requireValid(exactKeys(observed, ["target", "project"]));
      requireValid(
        observed.project === "markiro-platform" &&
          canonical(observed.target) === canonical(context.admission.identity.target),
      );
      await store.complete("admitted");
      await store.enter("target-stopped");
      await adapters.stopOwnedWorkloads(context);
      const stopped = await adapters.inspectStoppedWorkloads(context);
      requireValid(exactKeys(stopped, ["target", "project", "active"]));
      requireValid(
        stopped.project === "markiro-platform" &&
          canonical(stopped.target) === canonical(context.admission.identity.target),
      );
      requireValid(Array.isArray(stopped.active) && stopped.active.length === 0);
      await store.complete("target-stopped");
      await store.enter("backup-verified");
      const proof = await store.produceBackup((capability) =>
        adapters.createBackup(context, capability),
      );
      await store.complete("backup-verified", proof);
      return (await store.read()).backup;
    },
    options,
  );
}
