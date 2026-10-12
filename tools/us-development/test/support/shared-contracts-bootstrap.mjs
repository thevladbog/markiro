import { isDeepStrictEqual } from "node:util";

const owner = {
  name: "Build shared contracts for Node tooling checks",
  run: "pnpm turbo build --filter '@markiro/platform-contracts...'",
};
const checker = {
  name: "Reject release capabilities and merges into main",
  run: "node tools/us-development/check-isolation.mjs",
};
const nodeChecks = { run: "node --test tools/us-development/test/*.test.mjs" };

// Historical snapshots predate this prerequisite. Permit exactly this addition
// at its checked execution boundary, never malformed, duplicate or moved steps.
export function withoutSharedContractsBootstrap(workflow) {
  const result = structuredClone(workflow);
  const steps = result.jobs?.isolation?.steps;
  if (!steps) return result;
  const owners = steps.filter((step) => step.name === owner.name);
  if (owners.length !== 1 || !isDeepStrictEqual(owners[0], owner)) return result;
  const index = steps.indexOf(owners[0]);
  if (
    isDeepStrictEqual(steps[index - 1], checker) &&
    isDeepStrictEqual(steps[index + 1], nodeChecks)
  )
    steps.splice(index, 1);
  return result;
}

export function withoutSharedContractsBootstrapBytes(source) {
  const block = `      - name: ${owner.name}\n        run: ${owner.run}\n`;
  const before = `      - name: ${checker.name}\n        run: ${checker.run}\n`;
  const after = `      - run: ${nodeChecks.run}\n`;
  if (source.split(`      - name: ${owner.name}\n`).length !== 2) return source;
  return source.replace(before + block + after, before + after);
}
