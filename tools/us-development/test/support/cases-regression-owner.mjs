import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const filename = "us-cases-native.yml";
const rawSha256 = "5767893b3a396fd8502b095f6cfa6ab20ac1573195fbdfc221baf6ff48df00f6";
const fixture = "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
const nativeCommand =
  "corepack pnpm --filter @markiro/api exec vitest run test/us-case-demo-owned-application.e2e.test.ts test/us-case-demo-command.e2e.test.ts test/us-dataset-cases-prepare.e2e.test.ts test/us-dataset-cases-verify.e2e.test.ts test/us-dataset-cases-locks.e2e.test.ts test/us-dataset-cases-seed.e2e.test.ts test/us-dataset-regular-seed.e2e.test.ts test/us-dataset-shipping-seed.e2e.test.ts --maxWorkers=1 --reporter=verbose";
const catalog = "node tools/us-development/verify-cases-fixture.mjs";
const expected = {
  name: "US Cases native regression",
  on: { push: { branches: ["codex/us-mvp"] }, workflow_dispatch: null },
  permissions: { contents: "read" },
  concurrency: { group: "us-cases-native-${{ github.ref }}", "cancel-in-progress": true },
  jobs: {
    cases_native: {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 30,
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
        { run: "node --test tools/us-development/test/*.test.mjs tools/ci/test/*.test.mjs" },
        {
          name: "Build isolated API dependencies and entry points",
          run: "pnpm turbo build --filter '@markiro/api...'",
        },
        {
          name: "Verify empty Cases fixture before regression",
          env: { US_TEST_DATABASE_URL: fixture },
          run: catalog,
        },
        {
          name: "Verify complete Cases native regression on disposable databases",
          env: { US_TEST_DATABASE_URL: fixture },
          run: nativeCommand,
        },
        {
          name: "Verify empty Cases fixture after regression",
          if: "always()",
          env: { US_TEST_DATABASE_URL: fixture },
          run: catalog,
        },
      ],
    },
  },
};

export function assertSupplementalOwnership(workflows, rawSources) {
  if (!Object.hasOwn(workflows, filename) || !Object.hasOwn(rawSources, filename))
    throw new Error("Cases supplement is missing");
  if (!isDeepStrictEqual(workflows[filename], expected))
    throw new Error("Cases supplement parsed workflow differs from frozen contract");
  if (createHash("sha256").update(rawSources[filename]).digest("hex") !== rawSha256)
    throw new Error("Cases supplement bytes differ from frozen contract");
  for (const [name, workflow] of Object.entries(workflows)) {
    if (name !== filename && isDeepStrictEqual(workflow, expected))
      throw new Error("Cases supplement has a renamed or duplicate workflow");
  }
}

export function withoutCasesRegressionWorkflow(workflows, rawSources) {
  const result = structuredClone(workflows);
  try {
    assertSupplementalOwnership(workflows, rawSources);
    delete result[filename];
  } catch {
    // A malformed or absent entry remains visible to primary inventory assertions.
  }
  return result;
}
