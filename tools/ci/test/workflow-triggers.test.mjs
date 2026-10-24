import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { load } from "js-yaml";

function workflow(name) {
  return load(readFileSync(`.github/workflows/${name}`, "utf8"));
}

test("every repository workflow has an explicit reviewed event scope", () => {
  const expectedEvents = {
    "ci.yml": ["pull_request", "push", "workflow_dispatch"],
    "dependency-review.yml": ["pull_request"],
    "deploy-platform.yml": ["workflow_dispatch"],
    "handheld-release.yml": ["workflow_dispatch"],
    "recover-platform.yml": ["workflow_dispatch"],
    "release-platform-images.yml": ["workflow_dispatch"],
    "signer-download-repair.yml": ["workflow_dispatch"],
    "signer-stable-release.yml": ["workflow_dispatch"],
    "standalone-load.yml": ["workflow_dispatch"],
    "station-beta-release.yml": ["workflow_dispatch"],
    "station-release-reseed.yml": ["workflow_dispatch"],
    "station-stable-release.yml": ["workflow_dispatch"],
  };
  const workflowFiles = readdirSync(".github/workflows")
    .filter((name) => name.endsWith(".yml"))
    .sort();

  assert.deepEqual(workflowFiles, Object.keys(expectedEvents).sort());
  for (const name of workflowFiles) {
    assert.deepEqual(Object.keys(workflow(name).on).sort(), expectedEvents[name].sort(), name);
  }
});

test("dependency review runs only for supported dependency surface changes", () => {
  const value = workflow("dependency-review.yml");

  assert.deepEqual(value.on.pull_request, {
    branches: ["main"],
    paths: [
      ".github/workflows/*.yml",
      ".github/workflows/*.yaml",
      ".npmrc",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "patches/**",
      "apps/*/package.json",
      "packages/*/package.json",
      "tools/production-browser/package.json",
      "tools/production-browser/pnpm-lock.yaml",
      "**/Cargo.toml",
      "**/Cargo.lock",
    ],
  });
  assert.deepEqual(value.concurrency, {
    group: "dependency-review-${{ github.event.pull_request.number }}",
    "cancel-in-progress": true,
  });
});
test("the standalone load test is opt-in, read-only and fits the job limit", () => {
  const value = workflow("standalone-load.yml");

  assert.deepEqual(value.permissions, { contents: "read" });
  assert.deepEqual(value.on.workflow_dispatch.inputs.profile.options, ["smoke", "tiny", "soak"]);
  assert.equal(value.on.workflow_dispatch.inputs.profile.default, "smoke");
  assert.ok(value.jobs.load["timeout-minutes"] <= 360);
  assert.equal(value.jobs.load.env.PROFILE, "${{ inputs.profile }}");
  for (const step of value.jobs.load.steps) {
    assert.ok(
      !/\$\{\{\s*inputs\./u.test(step.run ?? ""),
      "an input reaches a shell through env, never inline",
    );
    assert.ok(
      !/--accept-network-exposure|--host\s+spawn/u.test(step.run ?? ""),
      "a shared runner never runs a network-exposed spawned host",
    );
    if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}\b/u, "actions are pinned by SHA");
  }
});
