import { canonical, ensure, keys } from "../backup/schemas.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { withUpgradeState } from "./upgrade-state.mjs";
import {
  validateOldRuntime,
  validateUpgradeSchema,
  validateUpgradePreparation,
} from "./upgrade-proofs.mjs";
import { validateBackup } from "./state-validation.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
const methods = [
  "verifyAdmission",
  "inspectOld",
  "inspectSchema",
  "stopOldEdge",
  "stopOldApi",
  "inspectStoppedOld",
  "createBackup",
];

// All adapters are installed trusted code. Operation JSON cannot provide one.
// Stops retain exact old containers. No migration/start/removal adapter exists.
export async function executeUpgradePreparation(input, adapters, options) {
  const context = snapshotActivation(input);
  keys(context, ["root", "admission"]);
  ensure(methods.every((name) => typeof adapters?.[name] === "function"));
  return withUpgradeState(
    context.root,
    context.admission,
    async (store) => {
      const call = (name) => store.guard((cap) => adapters[name](context, cap));
      same(await call("verifyAdmission"), context.admission.identity);
      const inspect = async (name) => {
        const observed = snapshotActivation(await call(name));
        keys(observed, [
          "version",
          "kind",
          "operationId",
          "configurationSha256",
          "target",
          "phase",
          "containers",
        ]);
        ensure(
          observed.version === 1 &&
            observed.kind === "platform-upgrade-observation" &&
            observed.operationId === context.admission.identity.operationId &&
            observed.configurationSha256 === context.admission.oldConfigurationSha256,
        );
        same(observed.target, context.admission.identity.target);
        ensure(observed.phase === (await store.read()).phase);
        return observed;
      };
      const observed = await inspect("inspectOld");
      const schema = validateUpgradeSchema(await call("inspectSchema"), context.admission.identity);
      const oldRuntime = validateOldRuntime(
        {
          version: 1,
          kind: "platform-upgrade-old-runtime",
          operationId: context.admission.identity.operationId,
          configurationSha256: context.admission.oldConfigurationSha256,
          containers: observed.containers,
          schema,
        },
        context.admission,
      );
      await store.complete("admitted", oldRuntime);
      await store.enter("old-stopped");
      await call("stopOldEdge");
      same((await inspect("inspectOld")).containers, oldRuntime.containers);
      await call("stopOldApi");
      same((await inspect("inspectStoppedOld")).containers, oldRuntime.containers);
      same(await call("inspectSchema"), schema);
      await store.complete("old-stopped");
      await store.enter("backup-verified");
      const result = snapshotActivation(await call("createBackup"));
      keys(result, ["backup", "fence"]);
      const backup = validateBackup(result.backup, context.admission.identity);
      same((await inspect("inspectStoppedOld")).containers, oldRuntime.containers);
      const sourceSchema = await call("inspectSchema");
      same(sourceSchema, schema);
      const prepared = validateUpgradePreparation(
        {
          version: 1,
          kind: "platform-upgrade-preparation",
          operationId: context.admission.identity.operationId,
          oldRuntime,
          backup,
          sourceSchema,
          fence: result.fence,
        },
        context.admission,
        oldRuntime,
        backup,
      );
      await store.complete("backup-verified", backup, prepared);
      return (await store.read()).preparation;
    },
    options,
  );
}
