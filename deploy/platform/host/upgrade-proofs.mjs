import { canonical, ensure, keys, hash } from "../backup/schemas.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { validateBackup } from "./state-validation.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
export function validateUpgradeSchema(value, identity) {
  keys(value, ["systemId", "schemaSha256", "migrationSha256", "migrationCount"]);
  ensure(
    value.systemId === identity.target.databaseId &&
      hash(value.schemaSha256) &&
      hash(value.migrationSha256),
  );
  ensure(
    typeof value.migrationCount === "string" && /^[1-9][0-9]{0,19}$/u.test(value.migrationCount),
  );
  return snapshotActivation(value);
}
export function validateOldRuntime(value, admission) {
  const v = snapshotActivation(value);
  keys(v, ["version", "kind", "operationId", "configurationSha256", "containers", "schema"]);
  ensure(
    v.version === 1 &&
      v.kind === "platform-upgrade-old-runtime" &&
      v.operationId === admission.identity.operationId &&
      v.configurationSha256 === admission.oldConfigurationSha256,
  );
  keys(v.containers, ["postgres", "api", "edge"]);
  ensure(
    Object.values(v.containers).every(hash) && new Set(Object.values(v.containers)).size === 3,
  );
  validateUpgradeSchema(v.schema, admission.identity);
  return v;
}
export function validateUpgradePreparation(value, admission, oldRuntime, backup) {
  const v = snapshotActivation(value);
  keys(v, ["version", "kind", "operationId", "oldRuntime", "backup", "sourceSchema", "fence"]);
  ensure(
    v.version === 1 &&
      v.kind === "platform-upgrade-preparation" &&
      v.operationId === admission.identity.operationId,
  );
  same(validateOldRuntime(v.oldRuntime, admission), oldRuntime);
  same(validateBackup(v.backup, admission.identity), backup);
  same(validateUpgradeSchema(v.sourceSchema, admission.identity), oldRuntime.schema);
  keys(v.fence, ["fenceId", "beganAt", "enforcementSha256"]);
  ensure(
    typeof v.fence.fenceId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        v.fence.fenceId,
      ),
  );
  ensure(
    hash(v.fence.enforcementSha256) &&
      typeof v.fence.beganAt === "string" &&
      Number.isFinite(Date.parse(v.fence.beganAt)) &&
      new Date(v.fence.beganAt).toISOString() === v.fence.beganAt,
  );
  return v;
}
