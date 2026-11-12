import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { load } from "js-yaml";

function workflow(name) {
  return load(readFileSync(`.github/workflows/${name}`, "utf8"));
}

test("every repository workflow has an explicit reviewed event scope", () => {
  const expectedEvents = {
    "bootstrap-release-catalog.yml": ["workflow_dispatch"],
    "ci.yml": ["pull_request", "push", "workflow_dispatch"],
    "configure-platform-dadata.yml": ["workflow_dispatch"],
    "dependency-review.yml": ["pull_request"],
    "deploy-platform.yml": ["workflow_dispatch"],
    "handheld-release.yml": ["workflow_dispatch"],
    "handheld-stable-release.yml": ["workflow_dispatch"],
    "migrate-handheld-signing.yml": ["workflow_dispatch"],
    "stage-handheld-catalog.yml": ["workflow_dispatch"],
    "recover-platform.yml": ["workflow_dispatch"],
    "upgrade-platform.yml": ["workflow_dispatch"],
    "release-platform-images.yml": ["workflow_dispatch"],
    "signer-download-repair.yml": ["workflow_dispatch"],
    "signer-stable-release.yml": ["workflow_dispatch"],
    "standalone-load.yml": ["workflow_dispatch"],
    "standalone-stable-release.yml": ["workflow_dispatch"],
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

test("the signing transfer reads only Android credentials under the old environment review", () => {
  const value = workflow("migrate-handheld-signing.yml");
  const job = value.jobs["seal-signing-secrets"];
  assert.deepEqual(value.permissions, {});
  assert.equal(job.permissions, undefined);
  assert.equal(job.environment, "handheld-release");
  for (const requirement of [
    "github.ref == 'refs/heads/main'",
    "github.actor == github.repository_owner",
    "github.triggering_actor == github.repository_owner",
    "github.run_attempt == 1",
    "inputs.reviewed_sha == github.sha",
  ]) {
    assert.ok(job.if.includes(requirement), requirement);
  }
  const withCredentials = job.steps.filter((step) => JSON.stringify(step).includes("secrets."));
  assert.equal(withCredentials.length, 1);
  const signingNames = [
    "MARKIRO_HANDHELD_KEYSTORE_BASE64",
    "MARKIRO_HANDHELD_STORE_PASSWORD",
    "MARKIRO_HANDHELD_KEY_ALIAS",
    "MARKIRO_HANDHELD_KEY_PASSWORD",
  ];
  assert.deepEqual(
    withCredentials[0].env,
    Object.fromEntries(signingNames.map((name) => [name, `\${{ secrets.${name} }}`])),
  );
  assert.doesNotMatch(withCredentials[0].run, /\$\{\{/u);
  const artifact = job.steps.find((step) => step.uses);
  assert.match(artifact.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/u);
  assert.equal(artifact.with.path, "${{ runner.temp }}/handheld-signing-transfer.json");
  assert.equal(artifact.with["retention-days"], 1);
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

test("read-only catalog bootstrap keeps manual independent approval, main or exact SHA-tag first attempt and host serialization", () => {
  const value = workflow("bootstrap-release-catalog.yml"),
    job = value.jobs.bootstrap;
  assert.deepEqual(Object.keys(value.on), ["workflow_dispatch"]);
  assert.deepEqual(value.permissions, { contents: "read" });
  assert.deepEqual(value.concurrency, {
    group: "timeweb-platform-production",
    "cancel-in-progress": false,
  });
  assert.equal(job.environment, "production-deploy");
  assert.equal(
    job.if,
    "${{ github.event_name == 'workflow_dispatch' && (github.ref == 'refs/heads/main' || github.ref == format('refs/tags/catalog-bootstrap-{0}', github.sha)) && github.run_attempt == 1 }}",
  );
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  for (const step of job.steps) {
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./u);
    if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}\b/u);
  }
});
