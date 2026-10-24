import { canonical, ensure, keys } from "../backup/schemas.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { withUpgradePhaseState } from "./upgrade-state.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
const methods = [
  "verifyAdmission",
  "inspectReturnEligibility",
  "inspectSchema",
  "startOldApi",
  "startOldEdge",
  "verifyOldHealth",
  "smoke",
  "cleanupOwnedStarts",
];
function failure(phase, error) {
  const result = new Error("Protected old-runtime return failed.");
  result.code = "ERR_HOST_UPGRADE_RETURN";
  result.phase = phase;
  result.recoveryRequired = true;
  result.durabilityUncertain = error?.durabilityUncertain === true;
  if (error?.terminationConfirmed === false) result.terminationConfirmed = false;
  return result;
}
// Trusted installed adapters construct fixed exact-ID start/stop commands. JSON
// provides no commands, scripts or alternate container selectors. All checks use
// old authority; candidate applications and migrations are absent from this API.
export async function executeUpgradeReturn(input, adapters, options) {
  let phase = "return-admitted";
  try {
    const operation = snapshotActivation(input);
    keys(operation, ["root", "decision"]);
    ensure(
      operation.decision.phase === "return-old" &&
        methods.every((n) => typeof adapters?.[n] === "function"),
    );
    return await withUpgradePhaseState(
      operation.root,
      operation.decision,
      async (store) => {
        const initial = await store.read();
        const oldRuntime = initial.oldRuntime;
        ensure(oldRuntime && !initial.migrationEntered);
        const context = snapshotActivation({ ...operation, oldRuntime });
        const call = (name) => store.guard((cap) => adapters[name](context, cap));
        const boundary = async () => {
          const o = snapshotActivation(await call("inspectReturnEligibility"));
          keys(o, [
            "version",
            "kind",
            "operationId",
            "configurationSha256",
            "target",
            "phase",
            "containers",
          ]);
          ensure(
            o.version === 1 &&
              o.kind === "platform-upgrade-observation" &&
              o.operationId === initial.admission.identity.operationId &&
              o.configurationSha256 === initial.admission.oldConfigurationSha256 &&
              o.phase === phase,
          );
          same(o.target, initial.admission.identity.target);
          same(o.containers, oldRuntime.containers);
          same(await call("inspectSchema"), oldRuntime.schema);
        };
        let startsAttempted = false;
        try {
          same(await call("verifyAdmission"), initial.admission.identity);
          await boundary();
          await store.complete(phase);
          for (const [next, start] of [
            ["old-api-started", "startOldApi"],
            ["old-edge-started", "startOldEdge"],
          ]) {
            phase = next;
            await store.enter(phase);
            await boundary();
            startsAttempted = true;
            await call(start);
            await boundary();
            await store.complete(phase);
          }
          phase = "returned-old";
          await store.enter(phase);
          await boundary();
          await call("verifyOldHealth");
          await boundary();
          await call("smoke");
          await boundary();
          await store.complete(phase);
          return oldRuntime;
        } catch (error) {
          if (error?.terminationConfirmed === false || error?.durabilityUncertain === true)
            throw error;
          await store.fail();
          if (startsAttempted)
            await store.cleanup((cap) => adapters.cleanupOwnedStarts(context, cap));
          throw error;
        }
      },
      options,
    );
  } catch (error) {
    throw failure(phase, error);
  }
}
