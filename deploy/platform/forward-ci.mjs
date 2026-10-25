/** Local synthetic rehearsal only. Never part of an installed executor closure. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isMainModule } from "../production/cli-main.mjs";
import { keys } from "./backup/schemas.mjs";
import { rehearseUpgrade } from "./upgrade-ci.mjs";
import { createForwardScenario, forwardProduct } from "./forward-ci-scenario.mjs";
// The shared engine invokes these actual guards before every nested command and
// re-inspects exact ownership through cleanupRehearsalResources in its finally.
export { validateRehearsalDaemon, cleanupRehearsalResources } from "./upgrade-ci-guards.mjs";
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
  if (value.completed) {
    assert.equal(value.problem, null);
    assert.equal(value.isolated, true);
    assert.equal(value.cleanup, true);
    assert.ok(Object.values(value.checks).every(Boolean));
  } else {
    assert.deepEqual(value.problem, {
      phase: "isolated forward rehearsal",
      code: "FORWARD_REHEARSAL_FAILED",
    });
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
  };
  try {
    assert.equal(
      process.platform,
      "linux",
      "Actual Linux renameat2/fsync rehearsal is required; run required Linux CI",
    );
    const success = createForwardScenario("healthy"),
      failure = createForwardScenario("replacement-failure");
    const a = await rehearseUpgrade(args, { forwardScenario: success });
    const b = await rehearseUpgrade(args, { forwardScenario: failure });
    result.isolated = a.isolated && b.isolated;
    result.cleanup = a.cleanup && b.cleanup;
    for (const name of checkNames)
      result.checks[name] = success.checks[name] === true || failure.checks[name] === true;
    result.completed = a.completed && b.completed;
    validateForwardRehearsalEvidence(result);
  } catch {
    result.completed = false;
    result.problem = { phase: "isolated forward rehearsal", code: "FORWARD_REHEARSAL_FAILED" };
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
