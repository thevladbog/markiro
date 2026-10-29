import test from "node:test";
import assert from "node:assert/strict";
const load = () => import("../forward-ci.mjs");
const product = "6e32b3bf5970ed8793293bcc7e80aef342836e53";
const checkNames = [
  "migrationAppliedOnce",
  "fullLedger",
  "realBackupRestore",
  "linuxHandoff",
  "noOldStarts",
  "noSecondMigrator",
  "forwardHealthy",
  "replacementFailureCleanup",
  "externalTls",
  "preBackupPredecessor",
  "directSuccessor",
  "activationSuccessor",
  "edgeSuccessor",
  "preservedHistory",
];
const run = (mode, i) => ({
  mode,
  operationId: `${i + 1}1111111-1111-4111-8111-111111111111`,
  failedOperationId: `${i + 3}1111111-1111-4111-8111-111111111111`,
  failedActivationOperationId: `${i + 7}1111111-1111-4111-8111-111111111111`,
  failedActivationStateSha256: "3".repeat(64),
  priorForwardOperationId: `${i + 5}1111111-1111-4111-8111-111111111111`,
  priorForwardStateSha256: "1".repeat(64),
  priorForwardIndexSha256: "2".repeat(64),
  admissionReadStage: "publisher",
  productSha: product,
  executorSha: "a".repeat(40),
  postgresId: String(i + 1).repeat(64),
  schema: {
    systemId: "1234",
    schemaSha256: "b".repeat(64),
    migrationSha256: "c".repeat(64),
    migrationCount: "202",
  },
  productMigrationProofSha256: "d".repeat(64),
  archiveSha256: "e".repeat(64),
  restoreEvidenceSha256: "f".repeat(64),
  terminalSha256: "a".repeat(64),
  duration: {
    productProofMs: 1000,
    prepareMs: 2000,
    activationMs: 3000,
    dockerCalls: 123,
    sourceVerifications: 456,
    activationDockerCalls: 100,
    activationSourceVerifications: 400,
    activationDockerTransportMs: 1200,
    activationIsolationMs: 400,
    activationSourceVerificationMs: 200,
  },
});
// Each scenario proves its own activation outcome; the rest is common.
const exclusive = {
  healthy: ["forwardHealthy", "externalTls"],
  "replacement-failure": ["replacementFailureCleanup"],
};
const scenario = (mode, i, overrides = {}) => ({
  version: 1,
  kind: "synthetic-only-forward-recovery-scenario",
  productionAdmission: false,
  invocationId: `${i + 1}2222222-2222-4222-8222-222222222222`,
  productSha: product,
  scenario: mode,
  completed: true,
  isolated: true,
  cleanup: true,
  checks: Object.fromEntries(
    checkNames.map((name) => [
      name,
      !Object.values(exclusive).flat().includes(name) || exclusive[mode].includes(name),
    ]),
  ),
  problem: null,
  runs: [run(mode, i)],
  ...overrides,
});

test("forward rehearsal accepts only an explicit known scenario besides the serial run", async () => {
  const { rehearseForwardRecovery } = await load();
  for (const args of [
    ["--local-ci", "--scenario"],
    ["--local-ci", "--scenario", "both"],
    ["--local-ci", "--scenario", "healthy", "extra"],
    ["--scenario", "healthy", "--local-ci"],
    ["--local-ci", "--host", "healthy"],
  ])
    await assert.rejects(rehearseForwardRecovery(args));
});

test("a scenario's evidence names one run of that scenario and claims completion only when clean", async () => {
  const { validateForwardScenarioEvidence } = await load();
  assert.equal(validateForwardScenarioEvidence(scenario("healthy", 0)).scenario, "healthy");
  assert.throws(() =>
    validateForwardScenarioEvidence(
      scenario("healthy", 0, { runs: [run("replacement-failure", 0)] }),
    ),
  );
  assert.throws(() => validateForwardScenarioEvidence(scenario("healthy", 0, { runs: [] })));
  assert.throws(() => validateForwardScenarioEvidence(scenario("healthy", 0, { cleanup: false })));
  assert.throws(() =>
    validateForwardScenarioEvidence(
      scenario("healthy", 0, { kind: "synthetic-only-forward-recovery-rehearsal" }),
    ),
  );
  assert.throws(() => validateForwardScenarioEvidence({ ...scenario("healthy", 0), extra: true }));
  const failed = scenario("healthy", 0, {
    completed: false,
    runs: [],
    problem: {
      phase: "isolated forward rehearsal",
      code: "FORWARD_REHEARSAL_FAILED",
      command: null,
      name: "Error",
      exitStatus: null,
      executable: null,
      processReason: null,
    },
  });
  assert.equal(validateForwardScenarioEvidence(failed).completed, false);
  assert.throws(() =>
    validateForwardScenarioEvidence({
      ...failed,
      problem: { ...failed.problem, command: "rm -rf /" },
    }),
  );
});

test("combined scenario evidence is the serial result: both complete and every check proven", async () => {
  const { combineForwardScenarioEvidence } = await load();
  const combined = combineForwardScenarioEvidence(
    scenario("healthy", 0),
    scenario("replacement-failure", 1),
  );
  assert.equal(combined.kind, "synthetic-only-forward-recovery-rehearsal");
  assert.equal(combined.completed, true);
  assert.deepEqual(
    combined.runs.map((value) => value.mode),
    ["healthy", "replacement-failure"],
  );
  assert.ok(Object.values(combined.checks).every(Boolean));
  // Swapped, incomplete, or a check that neither scenario proved.
  assert.throws(() =>
    combineForwardScenarioEvidence(scenario("replacement-failure", 1), scenario("healthy", 0)),
  );
  assert.throws(() =>
    combineForwardScenarioEvidence(
      scenario("healthy", 0),
      scenario("replacement-failure", 1, {
        completed: false,
        runs: [],
        problem: {
          phase: "isolated forward rehearsal",
          code: "FORWARD_REHEARSAL_FAILED",
          command: null,
          name: "Error",
          exitStatus: null,
          executable: null,
          processReason: null,
        },
      }),
    ),
  );
  const unproven = scenario("healthy", 0);
  unproven.checks.preservedHistory = false;
  const alsoUnproven = scenario("replacement-failure", 1);
  alsoUnproven.checks.preservedHistory = false;
  assert.throws(() => combineForwardScenarioEvidence(unproven, alsoUnproven));
  // The same operation identities in both runs are one namespace reused.
  assert.throws(() =>
    combineForwardScenarioEvidence(
      scenario("healthy", 0),
      scenario("replacement-failure", 0, { runs: [run("replacement-failure", 0)] }),
    ),
  );
});
