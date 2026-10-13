import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import {
  assertSupplementalOwnership,
  withoutCasesRegressionWorkflow,
} from "./support/cases-regression-owner.mjs";

const filename = "us-cases-native.yml";
const raw = `name: US Cases native regression

on:
  push:
    branches: [codex/us-mvp]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: us-cases-native-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  cases_native:
    runs-on: ubuntu-latest
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
      - run: node --test tools/us-development/test/*.test.mjs tools/ci/test/*.test.mjs
      - name: Build isolated API dependencies and entry points
        run: pnpm turbo build --filter '@markiro/api...'
      - name: Verify empty Cases fixture before regression
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: node tools/us-development/verify-cases-fixture.mjs
      - name: Verify complete Cases native regression on disposable databases
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: corepack pnpm --filter @markiro/api exec vitest run test/us-case-demo-owned-application.e2e.test.ts test/us-case-demo-command.e2e.test.ts test/us-dataset-cases-prepare.e2e.test.ts test/us-dataset-cases-verify.e2e.test.ts test/us-dataset-cases-locks.e2e.test.ts test/us-dataset-cases-seed.e2e.test.ts test/us-dataset-regular-seed.e2e.test.ts test/us-dataset-shipping-seed.e2e.test.ts --maxWorkers=1 --reporter=verbose
      - name: Verify empty Cases fixture after regression
        if: always()
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: node tools/us-development/verify-cases-fixture.mjs
`;

const inventory = () => {
  const sources = Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, readFileSync(`.github/workflows/${name}`, "utf8")]),
  );
  return [
    Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, load(source)])),
    sources,
  ];
};

test("complete Cases supplement has independently pinned bytes, AST and exact selector", () => {
  assert.equal(readFileSync(`.github/workflows/${filename}`, "utf8"), raw);
  const [workflows, sources] = inventory();
  assert.deepEqual(workflows[filename], load(raw));
  assert.doesNotThrow(() => assertSupplementalOwnership(workflows, sources));
  const reduced = withoutCasesRegressionWorkflow(workflows, sources);
  assert.notStrictEqual(reduced, workflows);
  assert.deepEqual(
    Object.keys(reduced),
    Object.keys(workflows).filter((name) => name !== filename),
  );
  assert.ok(workflows[filename]);
});

test("only the current exact supplement can be removed", (t) => {
  const [original, sources] = inventory();
  const reject = (name, mutate, rawMutation) => {
    const changed = structuredClone(original);
    const bytes = { ...sources };
    mutate(changed);
    rawMutation?.(bytes);
    const reduced = withoutCasesRegressionWorkflow(changed, bytes);
    assert.notStrictEqual(reduced, changed, name);
    assert.deepEqual(reduced, changed, name);
    assert.throws(() => assertSupplementalOwnership(changed, bytes), name);
  };
  const step = (w, name) => w[filename].jobs.cases_native.steps.find((item) => item.name === name);
  const native = "Verify complete Cases native regression on disposable databases";
  const pre = "Verify empty Cases fixture before regression";
  for (const [name, mutate, rawMutation] of [
    ["missing", (w) => delete w[filename]],
    [
      "renamed",
      (w) => {
        w.other = w[filename];
        delete w[filename];
      },
    ],
    [
      "second workflow",
      (w) => {
        w.other = structuredClone(w[filename]);
      },
    ],
    [
      "duplicate job",
      (w) => {
        w[filename].jobs.other = structuredClone(w[filename].jobs.cases_native);
      },
    ],
    [
      "trigger",
      (w) => {
        w[filename].on.push.branches = ["main"];
      },
    ],
    [
      "permissions",
      (w) => {
        w[filename].permissions.contents = "write";
      },
    ],
    [
      "defaults",
      (w) => {
        w[filename].defaults = { run: { shell: "bash" } };
      },
    ],
    [
      "environment",
      (w) => {
        w[filename].env = { CI: "true" };
      },
    ],
    [
      "budget",
      (w) => {
        w[filename].jobs.cases_native["timeout-minutes"] = 31;
      },
    ],
    [
      "service",
      (w) => {
        w[filename].jobs.cases_native.services["us-postgres"].image = "postgres:18-alpine";
      },
    ],
    [
      "extra job property",
      (w) => {
        w[filename].jobs.cases_native.needs = "isolation";
      },
    ],
    [
      "missing build",
      (w) => {
        w[filename].jobs.cases_native.steps.splice(7, 1);
      },
    ],
    [
      "missing prereq",
      (w) => {
        w[filename].jobs.cases_native.steps.splice(6, 1);
      },
    ],
    [
      "missing catalog",
      (w) => {
        w[filename].jobs.cases_native.steps = w[filename].jobs.cases_native.steps.filter(
          (s) => s.name !== pre,
        );
      },
    ],
    [
      "changed post condition",
      (w) => {
        step(w, "Verify empty Cases fixture after regression").if = "success()";
      },
    ],
    [
      "extra step",
      (w) => {
        w[filename].jobs.cases_native.steps.push({ run: "echo ignored" });
      },
    ],
    [
      "conditional native",
      (w) => {
        step(w, native).if = "false";
      },
    ],
    [
      "changed shell",
      (w) => {
        step(w, native).shell = "bash";
      },
    ],
    [
      "extra native environment",
      (w) => {
        step(w, native).env.DATABASE_URL = "other";
      },
    ],
    [
      "omitted file",
      (w) => {
        step(w, native).run = step(w, native).run.replace(
          " test/us-dataset-cases-seed.e2e.test.ts",
          "",
        );
      },
    ],
    [
      "duplicate file",
      (w) => {
        step(w, native).run += " test/us-dataset-cases-seed.e2e.test.ts";
      },
    ],
    [
      "filter",
      (w) => {
        step(w, native).run += " --testNamePattern=smoke";
      },
    ],
    [
      "retry",
      (w) => {
        step(w, native).run += " || true";
      },
    ],
    [
      "bytes only",
      () => {},
      (bytes) => {
        bytes[filename] += "\n";
      },
    ],
    [
      "raw missing",
      () => {},
      (bytes) => {
        delete bytes[filename];
      },
    ],
  ])
    t.test(name, () => reject(name, mutate, rawMutation));
});
