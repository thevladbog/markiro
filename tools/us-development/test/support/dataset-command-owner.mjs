import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import {
  withoutDatasetCommandPositiveOwner,
  withoutDatasetCommandPositiveOwnerBytes,
} from "./dataset-command-positive-owner.mjs";

const id = "dataset_command_refusals";
const block = `
  dataset_command_refusals:
    runs-on: ubuntu-latest
    needs: isolation
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Reject release capabilities and merges into main
        run: node tools/us-development/check-isolation.mjs
      - name: Build isolated API dependencies and entry points
        run: pnpm turbo build --filter '@markiro/api...'
      - name: Build checked dataset executable descriptor
        run: pnpm --filter @markiro/api build:us-request-worker
      - name: Verify dataset command policy and resource refusals without services
        run: corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-command.test.ts test/us-dataset-command-runtime.test.ts --maxWorkers=1
      - name: Verify compiled dataset command refusal without services
        run: node --test tools/us-development/test/dataset-command-entry.smoke.mjs
      - name: Verify exact dataset command refusal ownership
        run: node --test tools/us-development/test/dataset-command-ownership.test.mjs
`;
const expected = load(block)[id];

/** Remove only this exact reviewed no-service addition, retaining every mutant. */
export function withoutDatasetCommandOwner(workflow) {
  if (!isDeepStrictEqual(workflow.jobs?.[id], expected)) return structuredClone(workflow);
  workflow = withoutDatasetCommandPositiveOwner(workflow);
  const result = structuredClone(workflow);
  if (isDeepStrictEqual(result.jobs?.[id], expected)) delete result.jobs[id];
  return result;
}
export function withoutDatasetCommandOwnerBytes(source) {
  const original = source;
  source = withoutDatasetCommandPositiveOwnerBytes(source);
  if (
    !isDeepStrictEqual(load(source).jobs?.[id], expected) ||
    source.split(block).length !== 2 ||
    !source.endsWith(block)
  )
    return original;
  return source.slice(0, -block.length);
}
