import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";

export const preparedServicesJobId = "dataset_prepared_services";
export const preparedServicesFiles = [
  "test/us-plan-draft-transaction.e2e.test.ts",
  "test/us-dataset-prepared-intent.e2e.test.ts",
  "test/us-dataset-plan-seed.e2e.test.ts",
  "test/us-request-create-transaction.e2e.test.ts",
  "test/us-case-demo-owned-application.e2e.test.ts",
  "test/us-dataset-journal-reader.e2e.test.ts",
  "test/us-dataset-shipping-prerequisites.e2e.test.ts",
];
export const preparedServicesFixture =
  "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
export const preparedServicesCommand = `corepack pnpm --filter @markiro/api exec vitest run ${preparedServicesFiles.join(" ")} --maxWorkers=1`;
export const preparedServicesJob = {
  "runs-on": "ubuntu-latest",
  needs: "isolation",
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
    { run: "node --test tools/us-development/test/*.test.mjs" },
    {
      name: "Build isolated API dependencies and entry points",
      run: "pnpm turbo build --filter '@markiro/api...'",
    },
    {
      name: "Install PDF text extraction for US plan artifact checks",
      run: "sudo apt-get update && sudo apt-get install -y poppler-utils && pdftotext -v",
    },
    {
      name: "Verify prepared Plan, dataset intent, Plan seed and Request creation transactions",
      env: { US_TEST_DATABASE_URL: preparedServicesFixture },
      run: preparedServicesCommand,
    },
  ],
};

// Pin both the complete parsed job and its exact bytes. Historical snapshots
// permit only this reviewed addition; altered or extra properties stay visible.
export const preparedServicesJobBlock = `
  dataset_prepared_services:
    runs-on: ubuntu-latest
    needs: isolation
    timeout-minutes: 30
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
      - name: Install PDF text extraction for US plan artifact checks
        run: sudo apt-get update && sudo apt-get install -y poppler-utils && pdftotext -v
      - name: Verify prepared Plan, dataset intent, Plan seed and Request creation transactions
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: corepack pnpm --filter @markiro/api exec vitest run test/us-plan-draft-transaction.e2e.test.ts test/us-dataset-prepared-intent.e2e.test.ts test/us-dataset-plan-seed.e2e.test.ts test/us-request-create-transaction.e2e.test.ts test/us-case-demo-owned-application.e2e.test.ts test/us-dataset-journal-reader.e2e.test.ts test/us-dataset-shipping-prerequisites.e2e.test.ts --maxWorkers=1
`;

export function hasExactPreparedServicesOwner(workflow) {
  return isDeepStrictEqual(workflow.jobs?.[preparedServicesJobId], preparedServicesJob);
}

export function withoutPreparedServicesOwner(workflow) {
  const result = structuredClone(workflow);
  if (hasExactPreparedServicesOwner(result)) delete result.jobs[preparedServicesJobId];
  return result;
}

export function withoutPreparedServicesOwnerBytes(source) {
  if (
    !hasExactPreparedServicesOwner(load(source)) ||
    source.split(preparedServicesJobBlock).length !== 2 ||
    !source.endsWith(preparedServicesJobBlock)
  )
    return source;
  return source.slice(0, -preparedServicesJobBlock.length);
}
