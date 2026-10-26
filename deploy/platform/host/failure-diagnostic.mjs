import { basename } from "node:path";
import { writePrivateFile } from "./files.mjs";
import { backupFailureSites } from "../backup/schemas.mjs";

// Only safe, bounded metadata crosses wrappers. Never retain the error, cause,
// process arguments, environment, stack or output in this map.
const origins = new WeakMap();
const validationSites = new WeakMap();
export const hostFailureSites = (error) => validationSites.get(error) ?? backupFailureSites(error);
const confirmations = new WeakMap();
const records = new WeakSet();
const codes = new Set([
  "ERR_HOST_FAILURE",
  "ERR_HOST_FORWARD_PRODUCT",
  "ERR_HOST_FORWARD_ADMISSION",
  "ERR_HOST_FORWARD_PREPARATION",
  "ERR_HOST_FORWARD_ACTIVATION",
  "ERR_HOST_PROCESS",
  "ERR_HOST_OBSERVATION",
  "ERR_HOST_PRIVATE_FILE",
  "ERR_HOST_DEPLOYMENT",
  "ERR_HOST_RECOVERY_ADMISSION",
  "ERR_HOST_STATE",
  "ERR_HOST_LOCK_RELEASE",
  "ERR_HOST_COMMAND",
  "ERR_TARGET_BACKUP",
  "ERR_UPGRADE_COMMAND",
  "ERR_HOST_RECOVERY_COMMAND",
  "ERR_HOST_UPGRADE_ACTIVATION",
  "ERR_HOST_UPGRADE_RETURN",
  "ERR_HOST_UPGRADE_ADMISSION",
  "ERR_HOST_RECOVERY_ACTIVATION",
  "ERR_DATABASE_BACKUP",
  "ERR_UPGRADE_DISPATCH",
]);
const names = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
]);
const executables = new Set([
  "docker",
  "python3",
  "node",
  "psql",
  "pg_dump",
  "pg_restore",
  "ssh",
  "bash",
  "sh",
  "git",
  "pnpm",
  "gpg",
]);
const phases = new Set([
  "prepare",
  "activate",
  "return-old",
  "activation-admitted",
  "migration-entered",
  "migrated",
  "api-started",
  "edge-started",
  "healthy",
  "admitted",
  "source-held",
  "old-stopped",
  "backup-verified",
]);
const boundaries = new Set([
  "entry",
  "completion",
  "command",
  "release",
  "validation",
  "probe",
  "restore-cleanup",
  "recovery",
  "verifyRelease",
  "verifyImages",
  "verifyRoles",
  "inspectTarget",
  "verifyAdmission",
  "inspectSource",
  "createBackup",
  "backup-verification",
  "inspectStoppedOld",
  "inspectCandidate",
  "inspectSchema",
  "inspectMigration",
  "smoke",
  "cleanupOwnedWorkloads",
  "cleanupOwnedProbes",
]);
const categories = new Set([
  "validation",
  "probe",
  "image-check",
  "api-up",
  "edge-up",
  "migration",
  "smoke",
  "cleanup",
  "unknown",
]);
const object = (value) =>
  value !== null && (typeof value === "object" || typeof value === "function");
const own = (value, key) => {
  if (!object(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
};
function safeOrigin(error) {
  if (object(error) && origins.has(error)) return origins.get(error);
  let name = own(error, "name");
  if (name === undefined && object(error)) {
    // Native Error names are data properties of their immediate prototype.
    name = own(Object.getPrototypeOf(error), "name");
  }
  return Object.freeze({
    code: codes.has(own(error, "code")) ? own(error, "code") : "ERR_HOST_FAILURE",
    errorName: names.has(name) ? name : "Error",
    exitStatus: null,
    executable: null,
  });
}
export function noteHostProcessFailure(error, executable, exitStatus) {
  const name = typeof executable === "string" ? basename(executable) : null;
  origins.set(
    error,
    Object.freeze({
      ...safeOrigin(error),
      executable: executables.has(name) ? name : null,
      exitStatus:
        Number.isSafeInteger(exitStatus) && exitStatus >= 0 && exitStatus <= 255
          ? exitStatus
          : null,
    }),
  );
  return error;
}
export function carryHostFailure(source, target) {
  origins.set(target, safeOrigin(source));
  validationSites.set(target, hostFailureSites(source));
  confirmations.set(
    target,
    own(source, "terminationConfirmed") ?? (object(source) ? confirmations.get(source) : undefined),
  );
  // These are public safety flags already used to decide whether to retain locks.
  if (own(source, "terminationConfirmed") === false) target.terminationConfirmed = false;
  if (own(source, "durabilityUncertain") === true) target.durabilityUncertain = true;
  return target;
}
export function sanitizeHostFailure(error, context) {
  const operationId = own(context, "operationId"),
    phase = own(context, "phase"),
    boundary = own(context, "boundary"),
    commandCategory = own(context, "commandCategory");
  if (
    typeof operationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(operationId) ||
    !phases.has(phase) ||
    !boundaries.has(boundary) ||
    !categories.has(commandCategory)
  )
    throw new Error("Invalid host failure context.");
  const record = Object.freeze({
    version: 1,
    kind: "platform-host-failure",
    operationId,
    phase,
    boundary,
    commandCategory,
    ...safeOrigin(error),
    terminationConfirmed:
      (own(error, "terminationConfirmed") ??
        (object(error) ? confirmations.get(error) : undefined)) === true,
    durabilityUncertain: own(error, "durabilityUncertain") === true,
  });
  records.add(record);
  return record;
}
export async function writeHostFailure(directory, record) {
  // Only records minted by the sanitizer may reach serialization.
  if (!object(record) || !records.has(record)) throw new Error("Invalid host failure record.");
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (bytes.length > 4096) throw new Error("Invalid host failure size.");
  await writePrivateFile(directory, "failure.json", bytes);
}
