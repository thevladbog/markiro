import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import {
  withoutCanonicalTestsOwner,
  withoutCanonicalTestsOwnerBytes,
} from "./canonical-tests-owner.mjs";

export const preparedServicesJobId = "dataset_prepared_services";
export const preparedServicesFiles = [
  "test/us-plan-draft-transaction.e2e.test.ts",
  "test/us-dataset-prepared-intent.e2e.test.ts",
  "test/us-dataset-plan-seed.e2e.test.ts",
  "test/us-dataset-request-seed.e2e.test.ts",
  "test/us-dataset-artifact-seed.e2e.test.ts",
  "test/us-request-create-transaction.e2e.test.ts",
  "test/us-request-prepare-transaction.e2e.test.ts",
  "test/us-case-demo-owned-application.e2e.test.ts",
  "test/us-dataset-journal-reader.e2e.test.ts",
  "test/us-dataset-shipping-prerequisites.e2e.test.ts",
  "test/us-dataset-unit-composition.e2e.test.ts",
  "test/us-owner-provenance-procedure.e2e.test.ts",
  "test/us-owner-provenance-procedure-locks.e2e.test.ts",
  "test/us-owner-provenance-adapter.e2e.test.ts",
  "test/us-terminal-native-readers.e2e.test.ts",
  "test/us-terminal-verification-routing.e2e.test.ts",
  "test/us-terminal-closed-reader.e2e.test.ts",
  "test/us-dataset-unit-composition-semantics.e2e.test.ts",
  "test/us-dataset-unit-coordinator.e2e.test.ts",
  "test/us-dataset-composition-measurements.e2e.test.ts",
  "test/us-dataset-corrected-terminal-reader.e2e.test.ts",
  "test/us-dataset-native-final-reader.e2e.test.ts",
  "test/us-request-worker-scoped.e2e.test.ts",
  "test/us-transformation-structured-snapshot.e2e.test.ts",
];
export const preparedServicesFixture =
  "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
export const preparedServicesPartition = {
  dataset_prepared_services: [
    ...preparedServicesFiles.slice(0, 7),
    ...preparedServicesFiles.slice(22),
  ],
  dataset_terminal_readers: [
    ...preparedServicesFiles.slice(11, 17),
    ...preparedServicesFiles.slice(20, 22),
  ],
  dataset_unit_composition: [
    ...preparedServicesFiles.slice(7, 11),
    ...preparedServicesFiles.slice(17, 20),
  ],
};
export const preparedServicesJobIds = Object.keys(preparedServicesPartition);
export const preparedServicesCommands = Object.fromEntries(
  Object.entries(preparedServicesPartition).map(([id, files]) => [
    id,
    `corepack pnpm --filter @markiro/api exec vitest run ${files.join(" ")} --maxWorkers=1`,
  ]),
);
export const preparedServicesCommand = preparedServicesCommands[preparedServicesJobId];
export const ownerProvenanceDbCommand =
  "corepack pnpm --filter @markiro/db exec vitest run test/us-owner-provenance-migration.test.ts test/us-transformation-structured-snapshot-migration.e2e.test.ts --maxWorkers=1";
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
    {
      name: "Verify US owner provenance migration on a disposable database",
      env: { US_TEST_DATABASE_URL: preparedServicesFixture },
      run: ownerProvenanceDbCommand,
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
        run: corepack pnpm --filter @markiro/api exec vitest run test/us-plan-draft-transaction.e2e.test.ts test/us-dataset-prepared-intent.e2e.test.ts test/us-dataset-plan-seed.e2e.test.ts test/us-dataset-request-seed.e2e.test.ts test/us-dataset-artifact-seed.e2e.test.ts test/us-request-create-transaction.e2e.test.ts test/us-request-prepare-transaction.e2e.test.ts test/us-request-worker-scoped.e2e.test.ts test/us-transformation-structured-snapshot.e2e.test.ts --maxWorkers=1
      - name: Verify US owner provenance migration on a disposable database
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: corepack pnpm --filter @markiro/db exec vitest run test/us-owner-provenance-migration.test.ts test/us-transformation-structured-snapshot-migration.e2e.test.ts --maxWorkers=1
`;

const supplementalNames = {
  dataset_terminal_readers:
    "Verify US owner provenance and terminal readers on disposable databases",
  dataset_unit_composition: "Verify US owned dataset unit composition on disposable databases",
};
export const preparedServicesJobs = { [preparedServicesJobId]: preparedServicesJob };
export const preparedServicesJobBlocks = { [preparedServicesJobId]: preparedServicesJobBlock };
for (const [id, name] of Object.entries(supplementalNames)) {
  const job = structuredClone(preparedServicesJob);
  job.steps.pop();
  job.steps[9].name = name;
  job.steps[9].run = preparedServicesCommands[id];
  preparedServicesJobs[id] = job;
  const dbStart = preparedServicesJobBlock.indexOf(
    "      - name: Verify US owner provenance migration",
  );
  preparedServicesJobBlocks[id] = preparedServicesJobBlock
    .slice(0, dbStart)
    .replace("  dataset_prepared_services:", `  ${id}:`)
    .replace(preparedServicesJob.steps[9].name, name)
    .replace(preparedServicesCommand, preparedServicesCommands[id]);
}
export const preparedServicesPartitionBlock = preparedServicesJobIds
  .map((id) => preparedServicesJobBlocks[id])
  .join("");

export function hasExactPreparedServicesOwner(workflow) {
  return preparedServicesJobIds.every((id) =>
    isDeepStrictEqual(workflow.jobs?.[id], preparedServicesJobs[id]),
  );
}

export function withoutPreparedServicesOwner(workflow) {
  if (!hasExactPreparedServicesOwner(workflow)) return structuredClone(workflow);
  const result = withoutCanonicalTestsOwner(workflow);
  for (const id of preparedServicesJobIds) delete result.jobs[id];
  return result;
}

export function withoutPreparedServicesOwnerBytes(source) {
  if (
    !hasExactPreparedServicesOwner(load(source)) ||
    source.split(preparedServicesPartitionBlock).length !== 2 ||
    !source.endsWith(preparedServicesPartitionBlock)
  )
    return source;
  return withoutCanonicalTestsOwnerBytes(source).slice(0, -preparedServicesPartitionBlock.length);
}
