import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { load } from "js-yaml";

const WORKFLOW_URL = new URL("../../../.github/workflows/deploy-production.yml", import.meta.url);

function parseWorkflow(source) {
  const workflow = load(source);
  assert.ok(workflow && typeof workflow === "object" && !Array.isArray(workflow));
  return workflow;
}

function stepByName(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
}

function assertDirectDeployWorkflow(source) {
  const workflow = parseWorkflow(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "release_run_id",
    "release_sha",
    "landing_demo_submission_state",
  ]);
  assert.deepEqual(Object.keys(workflow.jobs), ["deploy"]);
  const deploy = workflow.jobs.deploy;
  assert.equal(deploy["runs-on"], "ubuntu-latest");
  assert.equal(deploy.environment, "production-deploy");
  assert.deepEqual(deploy.permissions, {
    actions: "read",
    contents: "read",
    packages: "read",
  });
  assert.equal(deploy.env.YC_APP_DEPLOY_LOGIN, "markiro-deploy");
  assert.equal(deploy.env.YC_APP_PUBLIC_ADDRESS, "${{ vars.YC_APP_PUBLIC_ADDRESS }}");
  assert.equal(deploy.env.APP_SSH_HOST_KEYS_B64, "${{ vars.APP_SSH_HOST_KEYS_B64 }}");
  assert.equal(deploy.env.ACME_EMAIL, "${{ vars.ACME_EMAIL }}");

  const checkout = deploy.steps.find((step) =>
    String(step.uses || "").startsWith("actions/checkout@"),
  );
  assert.ok(checkout);
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(checkout.with.ref, "${{ steps.release.outputs.release-sha }}");
  assert.equal(checkout.with["persist-credentials"], false);

  const validation = stepByName(deploy, "Validate exact release").run;
  assert.match(validation, /release-manifest[.]mjs validate/);
  assert.doesNotMatch(validation, /rehearsal|cleanup|ALB/i);

  const delivery = stepByName(deploy, "Deploy immutable Compose bundle");
  assert.equal(delivery.env.GHCR_TOKEN, "${{ github.token }}");
  assert.equal(delivery.env.GHCR_USERNAME, "${{ github.actor }}");
  assert.equal(
    delivery.env.YC_APP_DEPLOY_SSH_PRIVATE_KEY,
    "${{ secrets.YC_APP_DEPLOY_SSH_PRIVATE_KEY }}",
  );
  assert.match(delivery.run, /printf '%s\\n' "\$YC_APP_DEPLOY_SSH_PRIVATE_KEY" > "\$key_path"/);
  assert.match(delivery.run, /chmod 600 "\$key_path"/);
  assert.match(delivery.run, /remote-deploy[.]mjs run/);
  assert.doesNotMatch(delivery.run, /curl|oidc|iam_token|hosted-deploy-context|serial|lockbox/i);

  const cleanup = stepByName(deploy, "Remove local deployment credentials");
  assert.equal(cleanup.if, "always()");
  assert.match(cleanup.run, /markiro-deploy-key/);

  const withoutComments = source.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(
    withoutComments,
    /id-token|workflow_run|self-hosted|production-controller|production-cleanup|rollback_rehearsal|rehearsal_run|YC_IAM|YC_LOAD_BALANCER|YC_BACKEND_GROUP|YC_TARGET_GROUP|YC_REGISTRY_SECRET|hosted-deploy-context|serial/i,
  );
}

test("production deploy is one ordinary protected SSH job without Yandex control plane", async () => {
  assertDirectDeployWorkflow(await readFile(WORKFLOW_URL, "utf8"));
});

test("direct deploy workflow rejects automatic, unpinned and credential-unsafe mutations", async () => {
  const source = await readFile(WORKFLOW_URL, "utf8");
  const mutations = [
    [
      "automatic trigger",
      source.replace("  workflow_dispatch:", "  workflow_run:\n  workflow_dispatch:"),
    ],
    ["self hosted", source.replace("runs-on: ubuntu-latest", "runs-on: self-hosted")],
    ["OIDC", source.replace("contents: read", "contents: read\n      id-token: write")],
    [
      "unpinned checkout",
      source.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@main"),
    ],
    ["conditional cleanup", source.replace("if: always()", "if: success()")],
    [
      "wrong checkout",
      source.replace("${{ steps.release.outputs.release-sha }}", "${{ github.sha }}"),
    ],
  ];
  for (const [name, mutation] of mutations) {
    assert.notEqual(mutation, source, `${name} mutation must change the workflow`);
    assert.throws(() => assertDirectDeployWorkflow(mutation), undefined, name);
  }
});

test("remote deploy executable emits one bounded configuration diagnostic", () => {
  const executable = fileURLToPath(new URL("../remote-deploy.mjs", import.meta.url));
  const privateValue = "should-never-appear-from-hosted-runner";
  const result = spawnSync(process.execPath, [executable, "run"], {
    encoding: "utf8",
    env: {
      RELEASE_MANIFEST_PATH: `/runner/${privateValue}.json`,
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "MARKIRO_DEPLOY_FAILURE configuration\n");
  assert.equal(`${result.stdout}${result.stderr}`.includes(privateValue), false);
});
