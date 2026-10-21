import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import { checkWorkflows } from "../check-isolation.mjs";
import {
  withoutDatasetCommandOwner,
  withoutDatasetCommandOwnerBytes,
} from "./support/dataset-command-owner.mjs";

const id = "dataset_command_refusals";
const source = () => readFileSync(".github/workflows/us-development.yml", "utf8");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const expected = {
  "runs-on": "ubuntu-latest",
  needs: "isolation",
  "timeout-minutes": 30,
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
      name: "Reject release capabilities and merges into main",
      run: "node tools/us-development/check-isolation.mjs",
    },
    {
      name: "Build isolated API dependencies and entry points",
      run: "pnpm turbo build --filter '@markiro/api...'",
    },
    {
      name: "Build checked dataset executable descriptor",
      run: "pnpm --filter @markiro/api build:us-request-worker",
    },
    {
      name: "Verify dataset command policy and resource refusals without services",
      run: "corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-command.test.ts test/us-dataset-command-runtime.test.ts --maxWorkers=1",
    },
    {
      name: "Verify compiled dataset command refusal without services",
      run: "node --test tools/us-development/test/dataset-command-entry.smoke.mjs",
    },
    {
      name: "Verify exact dataset command refusal ownership",
      run: "node --test tools/us-development/test/dataset-command-ownership.test.mjs",
    },
  ],
};
function assertOwner(workflow, additional = []) {
  assert.deepEqual(workflow.jobs[id], expected);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs[id].services, undefined);
  const jobs = [workflow, ...additional].flatMap((entry) => Object.entries(entry.jobs ?? {}));
  assert.equal(jobs.filter(([key]) => key === id).length, 1);
  const steps = jobs.flatMap(([, job]) => job.steps ?? []);
  for (const selector of [
    "us-dataset-command.test.ts",
    "us-dataset-command-runtime.test.ts",
    "dataset-command-entry.smoke.mjs",
  ]) {
    const pattern = new RegExp(`(?<![\\w.-])${selector.replaceAll(".", "\\.")}(?![\\w/.-])`, "g");
    assert.equal(steps.flatMap((step) => [...(step.run ?? "").matchAll(pattern)]).length, 1);
  }
}
test("dataset command has one exact no-service check owner with unchanged predecessor", () => {
  const text = source();
  const workflow = load(text);
  assertOwner(workflow);
  const original = structuredClone(workflow);
  const normalized = withoutDatasetCommandOwner(workflow);
  assert.deepEqual(workflow, original);
  assert.equal(normalized.jobs[id], undefined);
  assert.equal(
    digest(JSON.stringify(normalized)),
    "11cf92fcad10c0cf1185237cf4d7e2f40a4bccaf90a35fc788fd5b606f32941b",
  );
  const bytes = withoutDatasetCommandOwnerBytes(text);
  assert.equal(digest(bytes), "e963a4b8d4773e2e37f8dac8bc9297d8b5355ad1e751756072c3868c4543cc3e");
  assert.deepEqual(load(bytes), normalized);
  const workflows = Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => [file, load(readFileSync(`.github/workflows/${file}`, "utf8"))]),
  );
  assertOwner(
    workflow,
    Object.entries(workflows)
      .filter(([file]) => file !== "us-development.yml")
      .map(([, value]) => value),
  );
  assert.deepEqual(checkWorkflows(workflows, "codex/us-mvp"), []);
});
test("dataset command ownership refuses selectors, services, skips, bypasses and changed budgets", () => {
  const mutations = [
    (w) => {
      delete w.jobs[id];
    },
    (w) => {
      w.jobs[id].services = { postgres: { image: "postgres:17-alpine" } };
    },
    (w) => {
      w.jobs[id]["timeout-minutes"] = 45;
    },
    (w) => {
      w.jobs[id].if = "false";
    },
    (w) => {
      w.jobs[id]["continue-on-error"] = true;
    },
    (w) => {
      w.jobs[id].permissions = { contents: "write" };
    },
    (w) => {
      w.jobs[id].steps[0].with["persist-credentials"] = true;
    },
    (w) => {
      w.jobs[id].steps[7].run += " --passWithNoTests";
    },
    (w) => {
      w.jobs[id].steps[7].run += " --testNamePattern=only";
    },
    (w) => {
      w.jobs[id].steps[7].run += " || true";
    },
    (w) => {
      w.jobs[id].steps[8].run += " || true";
    },
    (w) => {
      w.jobs[id].steps[8].if = "false";
    },
    (w) => {
      w.jobs[id].steps[8].env = { NODE_OPTIONS: "unsafe" };
    },
    (w) => {
      w.jobs[id].steps.reverse();
    },
    (w) => {
      w.jobs.extra = structuredClone(w.jobs[id]);
    },
  ];
  for (const mutate of mutations) {
    const workflow = load(source());
    mutate(workflow);
    assert.throws(() => assertOwner(workflow));
    if (workflow.jobs[id] && !workflow.jobs.extra)
      assert.deepEqual(withoutDatasetCommandOwner(workflow), workflow);
  }
  const changed = source().replace(
    "  dataset_command_refusals:\n",
    "  dataset_command_refusals: # changed\n",
  );
  assert.equal(withoutDatasetCommandOwnerBytes(changed), changed);
});

test("dataset command selectors are globally unique without mistaking aggregate or similar filenames", () => {
  const workflow = load(source());
  for (const run of [
    "vitest run test/us-dataset-command-runtime.test.ts",
    "node --test tools/us-development/test/dataset-command-entry.smoke.mjs",
  ])
    assert.throws(() => assertOwner(workflow, [{ jobs: { extra: { steps: [{ run }] } } }]));
  assert.throws(() => assertOwner(workflow, [{ jobs: { [id]: structuredClone(expected) } }]));
  for (const run of [
    "pnpm turbo test --filter=@markiro/api",
    "vitest run prefix-us-dataset-command-runtime.test.ts",
    "vitest run us-dataset-command-runtime.test.tsx",
  ])
    assertOwner(workflow, [{ jobs: { extra: { steps: [{ run }] } } }]);
});
