import { isDeepStrictEqual } from "node:util";
import {
  withoutSharedContractsBootstrap,
  withoutSharedContractsBootstrapBytes,
} from "./shared-contracts-bootstrap.mjs";

const owner = {
  name: "Verify pure native dataset assembly input",
  run: "corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-native-assembly-contract.test.ts --maxWorkers=1",
};
const block = `      - name: ${owner.name}\n        run: ${owner.run}\n`;

export function isNativeAssemblyOwner(step) {
  return isDeepStrictEqual(step, owner);
}

// Historical pins permit this complete additive owner only. Drift stays visible.
export function withoutNativeAssemblyOwner(workflow) {
  const result = withoutSharedContractsBootstrap(workflow);
  if (result.jobs?.isolation?.steps) {
    result.jobs.isolation.steps = result.jobs.isolation.steps.filter(
      (step) => !isNativeAssemblyOwner(step),
    );
  }
  return result;
}

export function withoutNativeAssemblyOwnerBytes(source) {
  source = withoutSharedContractsBootstrapBytes(source);
  return source.replace(block, (matched, offset) => {
    const followingLine = source
      .slice(offset + matched.length)
      .split("\n")
      .find((line) => !/^\s*(?:#.*)?$/.test(line));
    // A property after run is still part of this step: do not hide extra keys.
    return followingLine !== undefined && /^\s{8,}\S/.test(followingLine) ? matched : "";
  });
}
