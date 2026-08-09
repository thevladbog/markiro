import assert from "node:assert/strict";
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

function assertHostedDeployWorkflow(source) {
  const workflow = parseWorkflow(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.jobs), ["deploy"]);
  const deploy = workflow.jobs.deploy;
  assert.equal(deploy["runs-on"], "ubuntu-latest");
  assert.equal(deploy.environment, "production-deploy");
  assert.deepEqual(deploy.permissions, {
    actions: "read",
    contents: "read",
    "id-token": "write",
  });
  assert.equal(deploy.needs, undefined);
  assert.equal(deploy.env.YC_APP_DEPLOY_LOGIN, "markiro-deploy");
  assert.equal(deploy.env.MARKIRO_DEPLOYMENT_PHASE, "${{ inputs.deployment_phase }}");
  assert.equal(
    deploy.env.MARKIRO_ROLLBACK_REHEARSAL,
    "${{ inputs.rollback_rehearsal && '1' || '0' }}",
  );

  const checkout = deploy.steps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
  );
  assert.ok(checkout);
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(checkout.with.ref, "${{ steps.release.outputs.release-sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  for (const step of deploy.steps.filter((candidate) => candidate.uses))
    assert.match(step.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);

  const validation = stepByName(deploy, "Validate exact release and rollback prerequisite").run;
  assert.match(validation, /release-manifest[.]mjs validate/);
  assert.match(validation, /rollback-rehearsal-prerequisite\/rollback-rehearsal[.]json/);
  assert.match(validation, /deploymentRunAttempt/);
  assert.match(validation, /deploymentRunId/);
  assert.doesNotMatch(validation, /cleanup-receipt|runnerDeregistered|runnerVmStopped/);

  const delivery = stepByName(deploy, "Authenticate and deploy the immutable bundle");
  assert.equal(
    delivery.env.YC_APP_DEPLOY_SSH_PRIVATE_KEY,
    "${{ secrets.YC_APP_DEPLOY_SSH_PRIVATE_KEY }}",
  );
  assert.match(
    delivery.run,
    /if ! github_oidc_token="\$\(curl[\s\S]*?\|[\s\\]*jq -er[\s\S]*?\)"; then/,
  );
  assert.match(delivery.run, /if ! iam_token="\$\(curl[\s\S]*?\|[\s\\]*jq -er[\s\S]*?\)"; then/);
  assert.match(delivery.run, /printf '::add-mask::%s\\n' "\$github_oidc_token"/);
  assert.match(delivery.run, /printf '::add-mask::%s\\n' "\$iam_token"/);
  assert.match(delivery.run, /printf '%s' "\$YC_APP_DEPLOY_SSH_PRIVATE_KEY" > "\$key_path"/);
  assert.match(delivery.run, /chmod 600 "\$key_path"/);
  assert.match(delivery.run, /hosted-deploy-context[.]mjs resolve/);
  assert.match(delivery.run, /remote-deploy[.]mjs run/);
  assert.doesNotMatch(delivery.run, /ssh-keyscan|accept-new|runner-control|generate-jitconfig/);
  assert.doesNotMatch(delivery.run, /echo[^\n]*(?:PRIVATE_KEY|iam_token|github_oidc_token)/i);

  const cleanup = stepByName(deploy, "Remove local deployment credentials");
  assert.equal(cleanup.if, "always()");
  assert.match(cleanup.run, /markiro-deploy-key/);
  assert.match(cleanup.run, /markiro-hosted-deploy-context[.]json/);
  assert.match(cleanup.run, /release-manifest/);

  const sourceWithoutComments = source.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(
    sourceWithoutComments,
    /workflow_run|self-hosted|production-controller|production-cleanup|runner-label|YC_RUNNER_|cleanup-receipt|markiro-cleanup-/,
  );
  assert.match(
    source,
    /markiro-rollback-rehearsal-\$\{\{ steps[.]release[.]outputs[.]release-sha \}\}-attempt-/,
  );
  assert.match(
    source,
    /markiro-finalized-release-\$\{\{ steps[.]release[.]outputs[.]release-sha \}\}/,
  );
}

test("production deployment is one manually approved GitHub-hosted job with bounded credentials", async () => {
  assertHostedDeployWorkflow(await readFile(WORKFLOW_URL, "utf8"));
});

test("hosted workflow contract rejects automatic, multi-environment, unpinned and unclean delivery mutations", async () => {
  const source = await readFile(WORKFLOW_URL, "utf8");
  const mutations = [
    [
      "automatic trigger",
      source.replace(
        "  workflow_dispatch:",
        "  workflow_run:\n    workflows: [Publish production images]\n  workflow_dispatch:",
      ),
    ],
    ["self-hosted runner", source.replace("runs-on: ubuntu-latest", "runs-on: self-hosted")],
    [
      "second environment",
      source.replace("environment: production-deploy", "environment: production-controller"),
    ],
    ["OIDC permission", source.replace("id-token: write", "id-token: read")],
    [
      "unpinned checkout",
      source.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@main"),
    ],
    ["conditional cleanup", source.replace("if: always()", "if: success()")],
    [
      "missing context cleanup",
      source.replaceAll("markiro-hosted-deploy-context.json", "context-not-removed.json"),
    ],
    [
      "ambient checkout ref",
      source.replace("${{ steps.release.outputs.release-sha }}", "${{ github.sha }}"),
    ],
  ];

  for (const [name, mutation] of mutations) {
    assert.notEqual(mutation, source, `${name} mutation must change the workflow`);
    assert.throws(
      () => assertHostedDeployWorkflow(mutation),
      /workflow|Expected|match|equal|missing/i,
      name,
    );
  }
});
