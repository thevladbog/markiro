import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";

const previousCommand =
  "corepack pnpm --filter @markiro/api exec vitest run test/us-six-month-references.test.ts test/us-six-month-chains.test.ts test/us-six-month-definition.test.ts --maxWorkers=1";
const command =
  "corepack pnpm --filter @markiro/api exec vitest run test/us-six-month-references.test.ts test/us-six-month-chains.test.ts test/us-six-month-definition.test.ts test/us-dataset-native-digest-routing.test.ts test/us-demo-canonical.test.ts test/us-demo-canonical-ascii.test.ts --maxWorkers=1";
const owner = {
  name: "Verify pure six-month recipe and compiled timezone identity",
  if: "matrix.segment == 'office'",
  run: command,
};
const strategy = {
  "fail-fast": false,
  "max-parallel": 3,
  matrix: { segment: ["foundation", "dataset", "office", "requests", "browser", "persistence"] },
};
const block = `      - name: ${owner.name}\n        if: ${owner.if}\n        run: ${command}\n`;

function hasExactCanonicalTestsOwner(workflow) {
  const job = workflow.jobs?.isolation;
  if (
    !job ||
    !isDeepStrictEqual(Object.keys(job).sort(), [
      "runs-on",
      "services",
      "steps",
      "strategy",
      "timeout-minutes",
    ]) ||
    job["runs-on"] !== "ubuntu-latest" ||
    job["timeout-minutes"] !== 30 ||
    !isDeepStrictEqual(job.strategy, strategy) ||
    job.steps?.length !== 82 ||
    !isDeepStrictEqual(job.steps[22], owner)
  )
    return false;
  const steps = Object.values(workflow.jobs).flatMap((entry) => entry.steps ?? []);
  if (steps.filter((step) => step.name === owner.name).length !== 1) return false;
  for (const file of command.split(" ").filter((part) => part.startsWith("test/"))) {
    const selector = new RegExp(
      `(?<![\\w.-])${file.slice(5).replaceAll(".", "\\.")}(?![\\w/.-])`,
      "g",
    );
    if (steps.flatMap((step) => [...(step.run ?? "").matchAll(selector)]).length !== 1)
      return false;
  }
  return true;
}

// Restore only the exact reviewed addition. Any altered selection, owner, guard
// or failure handling remains visible to the unchanged historical workflow pins.
export function withoutCanonicalTestsOwner(workflow) {
  const result = structuredClone(workflow);
  if (hasExactCanonicalTestsOwner(workflow)) result.jobs.isolation.steps[22].run = previousCommand;
  return result;
}

export function withoutCanonicalTestsOwnerBytes(source) {
  if (!hasExactCanonicalTestsOwner(load(source)) || source.split(block).length !== 2) return source;
  return source.replace(block, block.replace(command, previousCommand));
}
