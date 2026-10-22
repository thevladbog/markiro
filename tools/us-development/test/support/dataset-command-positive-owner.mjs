import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import { withoutDemoViewerOwner, withoutDemoViewerOwnerBytes } from "./demo-viewer-owner.mjs";

const id = "dataset_command_positive";
const block = `
  dataset_command_positive:
    runs-on: ubuntu-latest
    needs: isolation
    timeout-minutes: 45
    services:
      us-postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: markiro_us
          POSTGRES_PASSWORD: markiro-us-development-only
          POSTGRES_DB: markiro_us_dev
        ports:
          - 127.0.0.1:55432:5432
        options: >-
          --health-cmd "pg_isready -U markiro_us -d markiro_us_dev"
          --health-interval 5s --health-timeout 5s --health-retries 10
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
      - name: Build shared contracts for Node tooling checks
        run: pnpm turbo build --filter '@markiro/platform-contracts...'
      - name: Reject release capabilities and merges into main
        run: node tools/us-development/check-isolation.mjs
      - run: node --test tools/us-development/test/*.test.mjs
      - name: Build isolated API dependencies and entry points
        run: pnpm turbo build --filter '@markiro/api...'
      - name: Build checked dataset executable descriptor
        run: pnpm --filter @markiro/api build:us-request-worker
      - name: Verify actual compiled dataset against owned database and private provider
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: node --test tools/us-development/test/dataset-command-positive.smoke.mjs
`;
const expected = load(block)[id];

/** Strip only the exact whole reviewed addition; malformed additions stay visible. */
export function withoutDatasetCommandPositiveOwner(workflow) {
  const result = isDeepStrictEqual(workflow.jobs?.[id], expected)
    ? withoutDemoViewerOwner(workflow)
    : structuredClone(workflow);
  if (isDeepStrictEqual(result.jobs?.[id], expected)) delete result.jobs[id];
  return result;
}
export function withoutDatasetCommandPositiveOwnerBytes(source) {
  const candidate = isDeepStrictEqual(load(source).jobs?.[id], expected)
    ? withoutDemoViewerOwnerBytes(source)
    : source;
  if (
    !isDeepStrictEqual(load(candidate).jobs?.[id], expected) ||
    candidate.split(block).length !== 2 ||
    !candidate.endsWith(block)
  )
    return source;
  return candidate.slice(0, -block.length);
}
