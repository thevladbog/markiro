/** Local synthetic rehearsal only. Never part of an installed executor closure. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isMainModule } from "../production/cli-main.mjs";
import { keys } from "./backup/schemas.mjs";
import { rehearseUpgrade } from "./upgrade-ci.mjs";
import { rehearsalFailure } from "./upgrade-ci-guards.mjs";
import { createForwardScenario, forwardProduct } from "./forward-ci-scenario.mjs";
// The shared engine invokes these actual guards before every nested command and
// re-inspects exact ownership through cleanupRehearsalResources in its finally.
export { validateRehearsalDaemon, cleanupRehearsalResources } from "./upgrade-ci-guards.mjs";
// Compiled stage labels and fixed child metadata only. Never project error text,
// private paths, argv, output or environment into the uploaded CI evidence.
const failurePhases = new Set([
  "isolated forward rehearsal",
  "stage isolated daemon",
  "owned cleanup",
  "partial creation requires exact inspection",
  "verify current ICU worker source closure",
  "verify current ICU worker archive",
  "copy current ICU worker archive",
  "verify copied ICU worker archive",
  "load current ICU worker archive",
  "verify current ICU worker image",
  "stage accepted API image",
  "stage accepted edge image",
  "stage current executor source closure",
  "pull exact accepted product images before disconnect",
  "remove every external network before application processes",
  "create private old source closure and generated configuration",
  "read exact old Git source closure",
  "hash current executable source closure",
  "generate private rehearsal TLS files",
  "write and verify generated private configuration snapshots",
  "stream and verify generated private tree in the isolated daemon",
  "verify copied private PostgreSQL TLS file metadata",
  "assign generated private PostgreSQL TLS file ownership",
  "verify pinned API runtime user",
  "assign generated private client CA file ownership",
  "bootstrap only synthetic PostgreSQL roles and old-image schema",
  "initialize exact private PostgreSQL volume ownership",
  "start isolated PostgreSQL and await health",
  "provision generated PostgreSQL roles",
  "apply exact old image migrations to synthetic database",
  "dump and restore the synthetic old schema before retaining applications",
  "verify old health/TLS, then stop and retain exact IDs",
  "return exact retained containers through guarded return coordinator",
  "prove migration latch rejects return before any start",
  "apply candidate migrations once, then fail canonically before API-up",
  "complete synthetic activation admission",
  "enter synthetic migration latch",
  "execute exact candidate migrations",
  "complete synthetic migration latch",
  "verify exact failed synthetic migration state",
]);
const failureCodes = new Set([
  "FORWARD_REHEARSAL_FAILED",
  "REHEARSAL_FAILED",
  "CLEANUP_FAILED",
  "PARTIAL_RESOURCES_RETAINED",
  "ERR_ASSERTION",
  "ERR_HOST_PROCESS",
  "ERR_HOST_OBSERVATION",
  "ERR_HOST_PRIVATE_FILE",
  "ERR_HOST_STATE",
  "ERR_DATABASE_BACKUP",
  "ERR_TARGET_BACKUP",
  "ERR_UPGRADE_COMMAND",
  "ERR_HOST_FORWARD_PRODUCT",
  "ERR_HOST_FORWARD_ADMISSION",
  "ERR_HOST_FORWARD_PREPARATION",
  "ERR_HOST_FORWARD_ACTIVATION",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOSPC",
  "ETIMEDOUT",
]);
const failureNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AssertionError",
  "AbortError",
  "AggregateError",
]);
const failureExecutables = new Set(["docker", "git", "openssl", "which", "tar"]);
const failureReasons = new Set([
  "missing-path",
  "worker-archive-missing",
  "docker-import-file-missing",
  "docker-storage-file-missing",
  "permission-denied",
  "read-only-filesystem",
  "capacity",
  "container-exec",
  "filesystem-not-supported",
  "invalid-archive",
  "layer-digest-mismatch",
  "unexpected-eof",
  "daemon-unavailable",
]);
const failureKeys = [
  "phase",
  "code",
  "command",
  "name",
  "exitStatus",
  "executable",
  "processReason",
];
const own = (value, key) =>
  value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
export function forwardRehearsalFailure(problem) {
  const phase = own(problem, "phase"),
    code = own(problem, "code"),
    command = own(problem, "command"),
    name = own(problem, "name"),
    exitStatus = own(problem, "exitStatus"),
    executable = own(problem, "executable"),
    processReason = own(problem, "processReason");
  const numericCode =
    typeof code === "string" &&
    /^PROCESS_EXIT_[0-9]{1,3}$/u.test(code) &&
    Number(code.slice(13)) <= 255;
  return {
    phase: failurePhases.has(phase) ? phase : "isolated forward rehearsal",
    code: failureCodes.has(code) || numericCode ? code : "FORWARD_REHEARSAL_FAILED",
    command:
      typeof command === "string" &&
      /^(?:git (?:show|ls-files|rev-parse)|openssl (?:req|x509)|tar archive|docker (?:cp|exec|network|image|container|volume|pull|run|inspect|info|context))$/u.test(
        command,
      )
        ? command
        : null,
    name: failureNames.has(name) ? name : "Error",
    exitStatus:
      Number.isSafeInteger(exitStatus) && exitStatus >= 0 && exitStatus <= 255 ? exitStatus : null,
    executable: failureExecutables.has(executable) ? executable : null,
    processReason: failureReasons.has(processReason) ? processReason : null,
  };
}
const checkNames = Object.freeze([
  "migrationAppliedOnce",
  "fullLedger",
  "realBackupRestore",
  "linuxHandoff",
  "noOldStarts",
  "noSecondMigrator",
  "forwardHealthy",
  "replacementFailureCleanup",
  "externalTls",
]);
const namespaceKeys = Object.freeze([
  "mode",
  "operationId",
  "failedOperationId",
  "productSha",
  "executorSha",
  "postgresId",
  "schema",
  "productMigrationProofSha256",
  "archiveSha256",
  "restoreEvidenceSha256",
  "terminalSha256",
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function namespace(value) {
  keys(value, namespaceKeys);
  assert.ok(["healthy", "replacement-failure"].includes(value.mode));
  for (const key of ["operationId", "failedOperationId"]) assert.match(value[key], uuid);
  assert.notEqual(value.operationId, value.failedOperationId);
  assert.equal(value.productSha, forwardProduct);
  assert.match(value.executorSha, /^[a-f0-9]{40}$/u);
  for (const key of [
    "postgresId",
    "productMigrationProofSha256",
    "archiveSha256",
    "restoreEvidenceSha256",
    "terminalSha256",
  ])
    assert.match(value[key], /^[a-f0-9]{64}$/u);
  keys(value.schema, ["systemId", "schemaSha256", "migrationSha256", "migrationCount"]);
  for (const key of ["systemId", "migrationCount"])
    assert.match(value.schema[key], /^[1-9][0-9]*$/u);
  for (const key of ["schemaSha256", "migrationSha256"])
    assert.match(value.schema[key], /^[a-f0-9]{64}$/u);
  return structuredClone(value);
}
const safeNamespace = (value) =>
  namespace(Object.fromEntries(namespaceKeys.map((key) => [key, value[key]])));
export function validateForwardRehearsalEvidence(value) {
  keys(value, [
    "version",
    "kind",
    "productionAdmission",
    "invocationId",
    "productSha",
    "completed",
    "isolated",
    "cleanup",
    "checks",
    "problem",
    "runs",
  ]);
  assert.equal(value.version, 1);
  assert.equal(value.kind, "synthetic-only-forward-recovery-rehearsal");
  assert.equal(value.productionAdmission, false);
  assert.equal(value.productSha, forwardProduct);
  assert.match(
    value.invocationId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  for (const name of ["completed", "isolated", "cleanup"])
    assert.equal(typeof value[name], "boolean");
  keys(value.checks, checkNames);
  for (const flag of Object.values(value.checks)) assert.equal(typeof flag, "boolean");
  assert.ok(Array.isArray(value.runs) && value.runs.length <= 2);
  value.runs.forEach(namespace);
  assert.equal(
    new Set(value.runs.flatMap((run) => [run.operationId, run.failedOperationId])).size,
    value.runs.length * 2,
  );
  if (value.completed) {
    assert.deepEqual(
      value.runs.map((run) => run.mode),
      ["healthy", "replacement-failure"],
    );
    assert.equal(value.problem, null);
    assert.equal(value.isolated, true);
    assert.equal(value.cleanup, true);
    assert.ok(Object.values(value.checks).every(Boolean));
  } else {
    if (Object.keys(value.problem ?? {}).length === 2) {
      // Historical failed artifacts contained only this conservative fallback.
      assert.deepEqual(value.problem, {
        phase: "isolated forward rehearsal",
        code: "FORWARD_REHEARSAL_FAILED",
      });
    } else {
      keys(value.problem, failureKeys);
      assert.deepEqual(value.problem, forwardRehearsalFailure(value.problem));
    }
  }
  return structuredClone(value);
}
export async function rehearseForwardRecovery(args, options = {}) {
  assert.deepEqual(args, ["--local-ci"]);
  keys(options, Object.hasOwn(options, "writeResult") ? ["writeResult"] : []);
  const writeResult = options.writeResult ?? (async () => {});
  assert.equal(typeof writeResult, "function");
  const result = {
    version: 1,
    kind: "synthetic-only-forward-recovery-rehearsal",
    productionAdmission: false,
    invocationId: randomUUID(),
    productSha: forwardProduct,
    completed: false,
    isolated: false,
    cleanup: false,
    checks: Object.fromEntries(checkNames.map((name) => [name, false])),
    problem: null,
    runs: [],
  };
  const innerResults = [];
  const runInner = async (forwardScenario) => {
    // Allocate before starting: an invocation without a terminal callback has
    // unknown isolation/cleanup, even if an earlier namespace completed safely.
    const observed = { isolated: false, cleanup: false, problem: null };
    innerResults.push(observed);
    return rehearseUpgrade(args, {
      forwardScenario,
      writeResult: async (evidence) => {
        // Only fixed metadata survives the compiled harness callback.
        observed.isolated = evidence.isolated === true;
        observed.cleanup = evidence.cleanup === true;
        observed.problem =
          evidence.problem === null ? null : forwardRehearsalFailure(evidence.problem);
      },
    });
  };
  try {
    assert.equal(
      process.platform,
      "linux",
      "Actual Linux renameat2/fsync rehearsal is required; run required Linux CI",
    );
    const success = createForwardScenario("healthy"),
      failure = createForwardScenario("replacement-failure");
    const a = await runInner(success);
    result.runs.push(safeNamespace(a.forward));
    const b = await runInner(failure);
    result.runs.push(safeNamespace(b.forward));
    result.isolated = a.isolated && b.isolated;
    result.cleanup = a.cleanup && b.cleanup;
    for (const name of checkNames)
      result.checks[name] = success.checks[name] === true || failure.checks[name] === true;
    result.completed = a.completed && b.completed;
    validateForwardRehearsalEvidence(result);
  } catch (error) {
    result.completed = false;
    result.isolated = innerResults.length > 0 && innerResults.every((value) => value.isolated);
    result.cleanup = innerResults.length > 0 && innerResults.every((value) => value.cleanup);
    result.problem =
      innerResults.at(-1)?.problem ??
      forwardRehearsalFailure(rehearsalFailure("isolated forward rehearsal", error));
    await writeResult(validateForwardRehearsalEvidence(result));
    throw Object.assign(
      new Error(
        "Forward rehearsal failed; preserve private evidence and inspect the exact stage. Actual Linux CI proof is required.",
      ),
      { code: "ERR_FORWARD_REHEARSAL" },
    );
  }
  await writeResult(validateForwardRehearsalEvidence(result));
  return validateForwardRehearsalEvidence(result);
}
if (isMainModule(import.meta.url))
  rehearseForwardRecovery(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
