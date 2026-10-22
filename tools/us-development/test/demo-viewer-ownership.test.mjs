import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const read = () => readFileSync(".github/workflows/us-development.yml", "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = "demo_viewer_acceptance";
// Independent whole literal: do not import the normalizer's expectation.
const block =
  "\n  demo_viewer_acceptance:\n    runs-on: ubuntu-latest\n    needs: isolation\n    timeout-minutes: 45\n    services:\n      us-postgres:\n        image: postgres:17-alpine\n        env:\n          POSTGRES_USER: markiro_us\n          POSTGRES_PASSWORD: markiro-us-development-only\n          POSTGRES_DB: markiro_us_dev\n        ports:\n          - 127.0.0.1:55432:5432\n        options: >-\n          --health-cmd \"pg_isready -U markiro_us -d markiro_us_dev\"\n          --health-interval 5s --health-timeout 5s --health-retries 10\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n        with:\n          persist-credentials: false\n      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4\n      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\n        with:\n          node-version: 24\n          cache: pnpm\n      - run: pnpm install --frozen-lockfile\n      - name: Build shared contracts for Node tooling checks\n        run: pnpm turbo build --filter '@markiro/platform-contracts...'\n      - name: Reject release capabilities and merges into main\n        run: node tools/us-development/check-isolation.mjs\n      - run: node --test tools/us-development/test/*.test.mjs\n      - name: Build isolated API dependencies and entry points\n        run: pnpm turbo build --filter '@markiro/api...'\n      - name: Build shared browser components\n        run: pnpm --filter @markiro/ui build\n      - name: Build checked dataset executable descriptor\n        run: pnpm --filter @markiro/api build:us-request-worker\n      - name: Verify reserved viewer command and store\n        env:\n          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev\n        run: pnpm --filter @markiro/api exec vitest run test/us-viewer-command.test.ts test/us-development-viewer.e2e.test.ts --maxWorkers=1\n      - name: Verify compiled viewer refusals\n        run: node --test tools/us-development/test/viewer-command.smoke.mjs\n      - name: Verify actual viewer HTTP permissions and audited downloads\n        env:\n          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev\n        run: pnpm --filter @markiro/api exec vitest run test/us-demo-viewer-http.e2e.test.ts --maxWorkers=1\n      - name: Verify bounded synthetic presentation marker\n        run: pnpm --filter @markiro/admin exec vitest run test/us-synthetic-demo.test.ts --maxWorkers=1\n      - name: Bootstrap pinned viewer browser verification tool\n        run: pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile\n      - name: Install pinned viewer Chromium\n        run: pnpm --dir tools/production-browser --ignore-workspace exec playwright install --with-deps chromium\n      - name: Verify viewer fixture refusals and owned disposal\n        run: pnpm --filter @markiro/api exec vitest run test/us-demo-viewer-browser-fixture.test.ts --maxWorkers=1\n      - name: Verify full-volume read-only viewer in one actual installation\n        env:\n          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev\n        run: corepack pnpm --filter @markiro/api exec node node_modules/vitest/vitest.mjs run test/us-demo-viewer-browser.e2e.test.ts --maxWorkers=1\n";
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
function uiPrerequisite(workflow) {
  const steps = workflow.jobs[id].steps;
  const builds = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.run === "pnpm --filter @markiro/ui build");
  assert.equal(builds.length, 1, "viewer requires exactly one actual UI build");
  assert.deepEqual(builds[0].step, {
    name: "Build shared browser components",
    run: "pnpm --filter @markiro/ui build",
  });
  const install = steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile");
  assert.ok(install >= 0 && install < builds[0].index, "UI build follows install");
  for (const [index, step] of steps.entries())
    if (
      step.run?.includes("--filter @markiro/admin") ||
      step.run?.includes("test/us-demo-viewer-browser.e2e.test.ts")
    )
      assert.ok(builds[0].index < index, "UI build precedes every viewer admin/browser consumer");
}
test("clean viewer runner owns an unconditional UI build before admin/browser consumers", () => {
  const workflow = load(read());
  uiPrerequisite(workflow);
  const manifest = JSON.parse(readFileSync("packages/ui/package.json", "utf8"));
  assert.equal(manifest.exports["."].default, "./dist/index.js");
  const api = JSON.parse(readFileSync("apps/api/package.json", "utf8"));
  assert.equal(api.dependencies["@markiro/ui"], undefined);
  for (const mutate of [
    (steps) => steps.filter((step) => step.run !== "pnpm --filter @markiro/ui build"),
    (steps) => [
      ...steps.filter((step) => step.run !== "pnpm --filter @markiro/ui build"),
      ...steps.filter((step) => step.run === "pnpm --filter @markiro/ui build"),
    ],
    (steps) =>
      steps.map((step) =>
        step.run === "pnpm --filter @markiro/ui build" ? { ...step, if: "false" } : step,
      ),
    (steps) =>
      steps.map((step) =>
        step.run === "pnpm --filter @markiro/ui build"
          ? { ...step, "continue-on-error": true }
          : step,
      ),
  ]) {
    const candidate = structuredClone(workflow);
    candidate.jobs[id].steps = mutate(candidate.jobs[id].steps);
    assert.throws(() => uiPrerequisite(candidate));
  }
});
function owner(workflow, others = []) {
  assert.deepEqual(workflow.jobs[id], expected);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const jobs = [workflow, ...others].flatMap((w) => Object.entries(w.jobs ?? {}));
  assert.equal(jobs.filter(([name]) => name === id).length, 1);
  const runs = jobs
    .flatMap(([, job]) => (job.steps ?? []).map((step) => step.run ?? ""))
    .join("\n");
  for (const selector of selectors) assert.equal(runs.split(selector).length - 1, 1, selector);
}
test("viewer final launch uses the direct installed Vitest entry without shim or environment bypass", async () => {
  const { withoutDemoViewerOwner, withoutDemoViewerOwnerBytes } =
    await import("./support/demo-viewer-owner.mjs");
  const source = read();
  const workflow = load(source);
  const direct =
    "corepack pnpm --filter @markiro/api exec node node_modules/vitest/vitest.mjs run test/us-demo-viewer-browser.e2e.test.ts --maxWorkers=1";
  assert.equal(workflow.jobs[id].steps.at(-1).run, direct);
  assert.equal(workflow.jobs[id].steps.at(-1)["working-directory"], undefined);
  assert.equal(source.split(direct).length, 2);
  owner(workflow);
  assert.equal(withoutDemoViewerOwner(workflow).jobs[id], undefined);
  assert.notEqual(withoutDemoViewerOwnerBytes(source), source);
  for (const run of [
    direct.replace("node node_modules/vitest/vitest.mjs", "vitest"),
    `env -u NODE_PATH -u NODE_OPTIONS ${direct}`,
    `NODE_PATH= NODE_OPTIONS= ${direct}`,
    `unset NODE_PATH NODE_OPTIONS; ${direct}`,
    direct.replace("exec node ", "exec node --require ./bypass.cjs "),
    direct.replace("exec node ", "exec node --import ./bypass.mjs "),
    direct.replace("exec node ", "exec node --experimental-loader ./bypass.mjs "),
    `${direct} --retry=1`,
    `${direct} --no-isolate`,
    direct.replace("--maxWorkers=1", "--maxWorkers=2"),
    direct.replace("@markiro/api", "@markiro/admin"),
    direct.replace("us-demo-viewer-browser.e2e.test.ts", "us-demo-viewer-browser-fixture.test.ts"),
    "cd apps/api && node node_modules/vitest/vitest.mjs run test/us-demo-viewer-browser.e2e.test.ts --maxWorkers=1",
    `CI=true GITHUB_JOB=demo_viewer_acceptance ${direct}`,
    `${direct} || true`,
    direct.replace("corepack ", ""),
    `pnpm exec ${direct}`,
    direct.replace("corepack pnpm", "corepack pnpm@11.10.0"),
    direct.replace("corepack pnpm", "corepack yarn"),
    `NODE_PATH=sentinel ${direct}`,
    `NODE_OPTIONS=--require=./bypass.cjs ${direct}`,
    `env -i ${direct}`,
    `${direct} --config ./other.config.ts`,
  ]) {
    const candidate = structuredClone(workflow);
    candidate.jobs[id].steps.at(-1).run = run;
    assert.throws(() => owner(candidate));
    assert.deepEqual(withoutDemoViewerOwner(candidate), candidate);
    const bytes = source.replace(direct, run);
    assert.equal(withoutDemoViewerOwnerBytes(bytes), bytes);
  }
  const wrongCwd = structuredClone(workflow);
  wrongCwd.jobs[id].steps.at(-1)["working-directory"] = "apps/api";
  assert.throws(() => owner(wrongCwd));
  assert.deepEqual(withoutDemoViewerOwner(wrongCwd), wrongCwd);
});
test("dedicated viewer has exact whole owner, selectors, caps and unchanged e5a predecessor", () => {
  const source = read();
  const workflow = load(source);
  owner(workflow);
  assert.ok(source.endsWith(block));
  assert.equal(source.split(block).length, 2);
  const before = source.slice(0, -block.length);
  assert.equal(hash(before), "cda7585f281263c55a57d03f7f126947fa0bb1e23e786b15359bf280fcba5e0b");
  assert.equal(
    hash(JSON.stringify(load(before))),
    "dbbf977a4714f5c2669c6442ab53b4af246cbb1a5989591a732c1f5767f6a712",
  );
  const others = readdirSync(".github/workflows")
    .filter((f) => /\.ya?ml$/.test(f) && f !== "us-development.yml")
    .map((f) => load(readFileSync(`.github/workflows/${f}`, "utf8")));
  owner(workflow, others);
});
test("viewer normalization preserves malformed additions and all old ownership mutants", async () => {
  const { withoutDemoViewerOwner, withoutDemoViewerOwnerBytes } =
    await import("./support/demo-viewer-owner.mjs");
  const { withoutDatasetCommandPositiveOwner, withoutDatasetCommandPositiveOwnerBytes } =
    await import("./support/dataset-command-positive-owner.mjs");
  const source = read(),
    workflow = load(source);
  const before = structuredClone(workflow);
  delete before.jobs[id];
  assert.deepEqual(withoutDemoViewerOwner(workflow), before);
  assert.deepEqual(workflow, load(source));
  assert.equal(withoutDemoViewerOwnerBytes(source), source.slice(0, -block.length));
  for (const mutate of [
    (w) => {
      delete w.jobs[id];
    },
    (w) => {
      w.jobs[id]["timeout-minutes"] = 46;
    },
    (w) => {
      w.jobs[id].permissions = { contents: "write" };
    },
    (w) => {
      w.jobs[id].if = "false";
    },
    (w) => {
      w.jobs[id]["continue-on-error"] = true;
    },
    (w) => {
      w.jobs[id].services["us-postgres"].ports = ["5432:5432"];
    },
    (w) => {
      w.jobs[id].steps.reverse();
    },
    (w) => {
      w.jobs[id].steps = w.jobs[id].steps.filter(
        (step) => step.run !== "pnpm --filter @markiro/ui build",
      );
    },
    (w) => {
      const steps = w.jobs[id].steps;
      const build = steps.splice(
        steps.findIndex((step) => step.run === "pnpm --filter @markiro/ui build"),
        1,
      )[0];
      steps.push(build);
    },
    (w) => {
      w.jobs[id].steps.at(-1).run += " --retry=1";
    },
    (w) => {
      w.jobs.extra = structuredClone(w.jobs[id]);
    },
    (w) => {
      w.jobs.extra = { steps: [{ run: expected.steps.at(-1).run }] };
    },
  ]) {
    const candidate = structuredClone(workflow);
    mutate(candidate);
    assert.throws(() => owner(candidate));
    assert.deepEqual(withoutDemoViewerOwner(candidate), candidate);
  }
  for (const candidate of [
    source + "\n",
    source + block,
    source.replace("  demo_viewer_acceptance:\n", "  demo_viewer_acceptance: #changed\n"),
    block + source.slice(0, -block.length),
  ]) {
    assert.equal(withoutDemoViewerOwnerBytes(candidate), candidate);
    try {
      load(candidate);
    } catch {
      assert.throws(() => withoutDatasetCommandPositiveOwnerBytes(candidate));
      continue;
    }
    assert.equal(withoutDatasetCommandPositiveOwnerBytes(candidate), candidate);
  }
  const changed = structuredClone(workflow);
  changed.jobs.dataset_command_positive["timeout-minutes"] = 46;
  assert.deepEqual(withoutDatasetCommandPositiveOwner(changed), changed);
  const changedBytes = source.replace(
    "  dataset_command_positive:\n",
    "  dataset_command_positive: #changed\n",
  );
  assert.equal(withoutDatasetCommandPositiveOwnerBytes(changedBytes), changedBytes);
});
