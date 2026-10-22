import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
const id = "demo_viewer_acceptance";
const block = `
  demo_viewer_acceptance:
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
      - name: Build shared browser components
        run: pnpm --filter @markiro/ui build
      - name: Build checked dataset executable descriptor
        run: pnpm --filter @markiro/api build:us-request-worker
      - name: Verify reserved viewer command and store
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: pnpm --filter @markiro/api exec vitest run test/us-viewer-command.test.ts test/us-development-viewer.e2e.test.ts --maxWorkers=1
      - name: Verify compiled viewer refusals
        run: node --test tools/us-development/test/viewer-command.smoke.mjs
      - name: Verify actual viewer HTTP permissions and audited downloads
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: pnpm --filter @markiro/api exec vitest run test/us-demo-viewer-http.e2e.test.ts --maxWorkers=1
      - name: Verify bounded synthetic presentation marker
        run: pnpm --filter @markiro/admin exec vitest run test/us-synthetic-demo.test.ts --maxWorkers=1
      - name: Bootstrap pinned viewer browser verification tool
        run: pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile
      - name: Install pinned viewer Chromium
        run: pnpm --dir tools/production-browser --ignore-workspace exec playwright install --with-deps chromium
      - name: Verify viewer fixture refusals and owned disposal
        run: pnpm --filter @markiro/api exec vitest run test/us-demo-viewer-browser-fixture.test.ts --maxWorkers=1
      - name: Verify full-volume read-only viewer in one actual installation
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: pnpm --filter @markiro/api exec node node_modules/vitest/vitest.mjs run test/us-demo-viewer-browser.e2e.test.ts --maxWorkers=1
`;
const expected = load(block)[id];
const selectors = [
  "us-viewer-command.test.ts",
  "us-development-viewer.e2e.test.ts",
  "viewer-command.smoke.mjs",
  "us-demo-viewer-http.e2e.test.ts",
  "us-synthetic-demo.test.ts",
  "us-demo-viewer-browser-fixture.test.ts",
  "us-demo-viewer-browser.e2e.test.ts",
];
function valid(workflow) {
  if (
    !isDeepStrictEqual(workflow.jobs?.[id], expected) ||
    !isDeepStrictEqual(workflow.permissions, { contents: "read" })
  )
    return false;
  const entries = Object.entries(workflow.jobs ?? {});
  if (entries.at(-1)?.[0] !== id) return false;
  const runs = entries
    .flatMap(([, job]) => (job.steps ?? []).map((step) => step.run ?? ""))
    .join("\n");
  return selectors.every((selector) => runs.split(selector).length === 2);
}
/** Remove only the reviewed whole final owner. Malformed additions remain visible. */
export function withoutDemoViewerOwner(workflow) {
  const result = structuredClone(workflow);
  if (valid(result)) delete result.jobs[id];
  return result;
}
export function withoutDemoViewerOwnerBytes(source) {
  try {
    if (!valid(load(source)) || source.split(block).length !== 2 || !source.endsWith(block))
      return source;
    return source.slice(0, -block.length);
  } catch {
    return source;
  }
}
