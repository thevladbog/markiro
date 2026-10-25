import { dirname, join } from "node:path";
import { canonical, ensure, keys } from "../backup/schemas.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import {
  withForwardPreparationState,
  validateForwardSourceRuntime,
  validateForwardPreparation,
} from "./forward-state.mjs";
import { validateProductMigrationLedger } from "./forward-ledger.mjs";
import { fingerprintHostConfiguration } from "./config.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";
import { carryHostFailure, sanitizeHostFailure, writeHostFailure } from "./failure-diagnostic.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
const methods = ["verifyAdmission", "inspectSource", "inspectSchema", "createBackup"];
export async function executeForwardPreparation(input, adapters, options) {
  let phase = "admitted",
    boundary = "validation";
  try {
    const context = snapshotActivation(input);
    keys(context, ["root", "admission", "configuration"]);
    keys(adapters, methods);
    ensure(methods.every((method) => typeof adapters[method] === "function"));
    const { root, admission, configuration } = context;
    return await withForwardPreparationState(
      root,
      admission,
      async (store) => {
        const call = (name, cleanup = false) => {
          boundary = name;
          const invoke = (cap) =>
            adapters[name]({ ...context, phase, boundary: cleanup ? "recovery" : name }, cap);
          return cleanup ? store.cleanup(invoke) : store.guard(invoke);
        };
        const checkConfiguration = async () => {
          boundary = "validation";
          ensure(
            (await fingerprintHostConfiguration({ root, ...configuration })).configurationSha256 ===
              admission.candidateConfigurationSha256,
          );
        };
        const observe = async () => {
          await checkConfiguration();
          const source = validateForwardSourceRuntime(await call("inspectSource"), admission);
          const ledger = snapshotActivation(await call("inspectSchema"));
          keys(ledger, ["version", "kind", "postgresId", "productProofSha256", "schema", "rows"]);
          ensure(
            ledger.version === 1 &&
              ledger.kind === "platform-forward-migration-observation" &&
              ledger.postgresId === admission.baseline.containers.postgres &&
              ledger.productProofSha256 === admission.baseline.productMigrationProofSha256,
          );
          same(ledger.schema, admission.baseline.schema);
          validateProductMigrationLedger(ledger.rows, options.productMigrationProof);
          return source;
        };
        try {
          await checkConfiguration();
          same(await call("verifyAdmission"), admission.identity);
          const source = await observe();
          await store.complete("admitted", source);
          phase = "source-held";
          boundary = "entry";
          await store.enter(phase);
          same(await observe(), source);
          await store.complete(phase);
          phase = "backup-verified";
          boundary = "entry";
          await store.enter(phase);
          same(await observe(), source);
          const result = snapshotActivation(await call("createBackup"));
          keys(result, ["backup", "restoreEvidence", "fence"]);
          boundary = "backup-verification";
          const verified = await readVerifiedBackup({
            root,
            identity: admission.identity,
            backup: result.backup,
            restoreEvidence: result.restoreEvidence,
          });
          ensure(
            verified.document.provenance === "live-source" &&
              verified.evidence.provenance === "live-source",
          );
          keys(result.fence, ["fenceId", "beganAt", "enforcementSha256"]);
          const { fenceId, beganAt, enforcementSha256 } = verified.document.fence.before;
          same(result.fence, { fenceId, beganAt, enforcementSha256 });
          same(await observe(), source);
          const preparation = validateForwardPreparation(
            {
              version: 1,
              kind: "platform-forward-preparation",
              operationId: admission.identity.operationId,
              sourceRuntime: source,
              backup: verified.backupProof,
              sourceSchema: source.schema,
              productMigrationProofSha256: admission.baseline.productMigrationProofSha256,
              fence: result.fence,
            },
            admission,
            source,
            verified.backupProof,
          );
          await store.complete(phase, verified.backupProof, preparation);
          const final = await store.read();
          ensure(
            final.sequence === 6 &&
              final.status === "completed" &&
              final.phase === "backup-verified" &&
              final.migrationEntered === true,
          );
          return admission.identity;
        } catch (error) {
          let record;
          try {
            record = sanitizeHostFailure(error, {
              operationId: admission.identity.operationId,
              phase,
              boundary,
              commandCategory: "validation",
            });
            await writeHostFailure(
              join(
                dirname(root),
                "upgrade-operations",
                admission.identity.operationId,
                "post-migration-prepare",
              ),
              record,
            );
          } catch {
            const unresolved = carryHostFailure(
              error,
              new Error("Forward preparation diagnostic persistence failed."),
            );
            unresolved.code = "ERR_HOST_FORWARD_PREPARATION";
            unresolved.durabilityUncertain = true;
            throw unresolved;
          }
          const descriptor =
            error && ["object", "function"].includes(typeof error)
              ? Object.getOwnPropertyDescriptor(error, "terminationConfirmed")
              : null;
          if (record.durabilityUncertain || descriptor?.value === false) throw error;
          await store.fail();
          try {
            await call("inspectSource", true);
          } catch {
            const unresolved = carryHostFailure(
              error,
              new Error("Forward preparation cleanup could not be confirmed."),
            );
            unresolved.code = "ERR_HOST_FORWARD_PREPARATION";
            unresolved.durabilityUncertain = true;
            throw unresolved;
          }
          throw error;
        }
      },
      options,
    );
  } catch (error) {
    const failure = new Error("Protected post-migration forward preparation failed.");
    failure.code = "ERR_HOST_FORWARD_PREPARATION";
    failure.phase = phase;
    failure.recoveryRequired = true;
    throw carryHostFailure(error, failure);
  }
}
