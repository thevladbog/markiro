import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";

export const traceReadinessJobId = "dataset_trace_readiness";
export const traceReadinessFiles = [
  "test/us-dataset-trace-readiness.e2e.test.ts",
  "test/us-dataset-trace-readiness-stage.e2e.test.ts",
  "test/us-dataset-trace-readiness-seed.e2e.test.ts",
  "test/us-dataset-shipping-projection.e2e.test.ts",
];
export const traceReadinessFixture =
  "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
export const traceReadinessCommand = `corepack pnpm --filter @markiro/api exec vitest run ${traceReadinessFiles.join(" ")} --maxWorkers=1`;
export const traceReadinessJob = {
  "runs-on": "ubuntu-latest",
  needs: "isolation",
  "timeout-minutes": 45,
  services: {
    "us-postgres": {
      image: "postgres:17-alpine",
      env: {
        POSTGRES_USER: "markiro_us",
        POSTGRES_PASSWORD: "markiro-us-development-only",
        POSTGRES_DB: "markiro_us_dev",
      },
      ports: ["127.0.0.1:55432:5432"],
      options:
        '--health-cmd "pg_isready -U markiro_us -d markiro_us_dev" --health-interval 5s --health-timeout 5s --health-retries 10',
    },
  },
  steps: [
    {
      uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      with: { "persist-credentials": false },
    },
    { uses: "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1" },
    {
      uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      with: { "node-version": 24, cache: "pnpm" },
    },
    { run: "pnpm install --frozen-lockfile" },
    {
      name: "Build shared contracts for Node tooling checks",
      run: "pnpm turbo build --filter '@markiro/platform-contracts...'",
    },
    {
      name: "Reject release capabilities and merges into main",
      run: "node tools/us-development/check-isolation.mjs",
    },
    { run: "node --test tools/us-development/test/*.test.mjs" },
    {
      name: "Build isolated API dependencies and entry points",
      run: "pnpm turbo build --filter '@markiro/api...'",
    },
    {
      name: "Verify dataset Trace/Readiness native proof, durable stage and full composition",
      env: { US_TEST_DATABASE_URL: traceReadinessFixture },
      run: traceReadinessCommand,
    },
  ],
};

// Pin both the complete parsed job and its exact bytes. Historical snapshots
// permit only this reviewed addition; altered or extra properties stay visible.
export const traceReadinessJobBlock = `
  dataset_trace_readiness:
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
      - name: Verify dataset Trace/Readiness native proof, durable stage and full composition
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-trace-readiness.e2e.test.ts test/us-dataset-trace-readiness-stage.e2e.test.ts test/us-dataset-trace-readiness-seed.e2e.test.ts test/us-dataset-shipping-projection.e2e.test.ts --maxWorkers=1
`;

export function hasExactTraceReadinessOwner(workflow) {
  return isDeepStrictEqual(workflow.jobs?.[traceReadinessJobId], traceReadinessJob);
}

export function withoutTraceReadinessOwner(workflow) {
  const result = structuredClone(workflow);
  if (hasExactTraceReadinessOwner(result)) delete result.jobs[traceReadinessJobId];
  return result;
}

export function withoutTraceReadinessOwnerBytes(source) {
  if (
    !hasExactTraceReadinessOwner(load(source)) ||
    source.split(traceReadinessJobBlock).length !== 2 ||
    !source.endsWith(traceReadinessJobBlock)
  )
    return source;
  return source.slice(0, -traceReadinessJobBlock.length);
}
