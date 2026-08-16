import assert from "node:assert/strict";

export const LEGAL_VERIFIER_BUILD_COMMAND =
  "pnpm --filter @markiro/domain build\npnpm --filter @markiro/legal-documents build\n";

export function assertLegalVerifierBuildsImmediatelyBeforeProductionContracts(workflow) {
  const steps = workflow.jobs["production-bundle"].steps;
  const contractIndex = steps.findIndex(
    (step) => step.name === "Verify production bundle contracts",
  );
  assert.notEqual(contractIndex, -1, "production bundle contract step must exist");
  const buildStep = steps[contractIndex - 1];
  assert.deepEqual(buildStep, {
    name: "Build legal verifier dependencies",
    run: LEGAL_VERIFIER_BUILD_COMMAND,
  });
  return buildStep;
}
