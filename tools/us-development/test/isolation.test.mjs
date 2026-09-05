import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { load } from "js-yaml";
import { checkWorkflows } from "../check-isolation.mjs";

const workflows = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, load(readFileSync(`.github/workflows/${name}`, "utf8"))]),
  );

test("every inherited operational job is unconditionally locked before it can obtain credentials", () => {
  const safe = new Set(["ci.yml", "dependency-review.yml", "us-development.yml"]);
  for (const [name, workflow] of Object.entries(workflows())) {
    if (safe.has(name)) continue;
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      assert.equal(job.if, "${{ false }}", `${name}/${jobId} is executable`);
    }
    if (workflow.concurrency) assert.match(workflow.concurrency.group, /^us-development-locked-/);
  }
});

test("US checks run on the development branch and cannot write repository or package state", () => {
  const workflow = workflows()["us-development.yml"];
  assert.ok(workflow, "US development workflow must exist");
  assert.deepEqual(workflow.on.push.branches, ["codex/us-mvp"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.environment, undefined);
    assert.equal(job.permissions, undefined);
  }
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\./);
});

test("release checker fails on a pull request to main, even with all workflows locked", () => {
  const result = spawnSync(process.execPath, ["tools/us-development/check-isolation.mjs"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_BASE_REF: "main" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /US development must not merge into main/);
});

test("US dependency stack has private ports and independently named persistent data", () => {
  const stack = load(readFileSync("deploy/us-development/compose.yml", "utf8"));
  assert.equal(stack.name, "markiro-us-development");
  assert.equal(stack.services.postgres.environment.POSTGRES_DB, "markiro_us_dev");
  assert.deepEqual(stack.services.postgres.ports, ["127.0.0.1:55432:5432"]);
  assert.deepEqual(stack.services.mailpit.ports, ["127.0.0.1:11025:1025", "127.0.0.1:18025:8025"]);
  assert.deepEqual(stack.services.minio.ports, ["127.0.0.1:19000:9000", "127.0.0.1:19001:9001"]);
  for (const volume of Object.values(stack.volumes)) {
    assert.equal(volume?.external, undefined);
    assert.equal(volume?.name, undefined);
  }
});

test("checker accepts the locked repository but rejects re-enabled and newly added release jobs", () => {
  const valid = workflows();
  assert.deepEqual(checkWorkflows(valid, "codex/us-mvp"), []);
  const unlocked = structuredClone(valid);
  unlocked["release-images.yml"].jobs.publish.if = "${{ true }}";
  assert.ok(checkWorkflows(unlocked).some((error) => error.includes("release-images.yml/publish")));
  const added = structuredClone(valid);
  added["unexpected.yml"] = { jobs: { publish: { "runs-on": "ubuntu-latest" } } };
  assert.ok(checkWorkflows(added).some((error) => error.includes("unexpected.yml/publish")));
});

for (const [label, mutate] of [
  [
    "write token",
    (workflow) => {
      workflow.permissions.contents = "write";
    },
  ],
  [
    "environment",
    (workflow) => {
      workflow.jobs.isolation.environment = "production-deploy";
    },
  ],
  [
    "secret",
    (workflow) => {
      workflow.jobs.isolation.env = { KEY: "${{ secrets.DEPLOY_KEY }}" };
    },
  ],
  [
    "delegated job",
    (workflow) => {
      workflow.jobs.isolation.uses = "./.github/workflows/deploy-production.yml";
    },
  ],
  [
    "removed checker",
    (workflow) => {
      workflow.jobs.isolation.steps = workflow.jobs.isolation.steps.filter(
        (step) => step.run !== "node tools/us-development/check-isolation.mjs",
      );
    },
  ],
  [
    "ignored checker failure",
    (workflow) => {
      workflow.jobs.isolation.steps.find(
        (step) => step.run === "node tools/us-development/check-isolation.mjs",
      )["continue-on-error"] = true;
    },
  ],
]) {
  test(`checker rejects ${label} in the development workflow`, () => {
    const changed = workflows();
    mutate(changed["us-development.yml"]);
    assert.notDeepEqual(checkWorkflows(changed), []);
  });
}
