import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { load } from "js-yaml";

import { assertLegalVerifierBuildsImmediatelyBeforeProductionContracts } from "./helpers/workflow-contract.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const parse = async (path) => load(await read(path));
const publicLandingBuildVariables = Object.freeze([
  "PUBLIC_DEMO_SUBMISSION_ENABLED",
  "PUBLIC_SMARTCAPTCHA_CLIENT_KEY",
  "PUBLIC_PHONE",
]);
const demoRuntimeVariables = Object.freeze([
  "LANDING_DEMO_SUBMISSION_ENABLED",
  "LANDING_ORIGIN",
  "LANDING_DEMO_RECIPIENT",
  "LANDING_DEMO_REPLY_TO",
  "SMARTCAPTCHA_SERVER_KEY",
]);
const retiredLegalEnvironmentVariables = Object.freeze([
  "PUBLIC_DEMO_CONSENT_VERSION",
  "LANDING_DEMO_CONSENT_VERSION",
  "PUBLIC_PRIVACY_POLICY_PATH",
  "PUBLIC_PERSONAL_DATA_CONSENT_PATH",
]);

function assertNoRetiredLegalEnvironmentVariables(source) {
  for (const variable of retiredLegalEnvironmentVariables)
    assert.doesNotMatch(source, new RegExp(variable));
}

function namedStep(workflow, job, name) {
  const step = workflow.jobs[job].steps.find((candidate) => candidate.name === name);
  assert.ok(step, `${job} must contain ${name}`);
  return step;
}

function assertEdgeBuildStep(step, expectedEnvironment) {
  assert.deepEqual(step.env, expectedEnvironment);
  assert.deepEqual(
    [...step.run.matchAll(/--build-arg\s+([A-Z0-9_]+)=/g)].map((match) => match[1]),
    publicLandingBuildVariables,
  );
  for (const variable of publicLandingBuildVariables) {
    assert.ok(step.run.includes(`--build-arg ${variable}="$${variable}"`));
  }
  assert.doesNotMatch(step.run, /--build-arg\s+(?:LANDING_|SMARTCAPTCHA_SERVER_KEY)/);
  assert.doesNotMatch(step.run, /(?:echo|printf)[^\n]*PUBLIC_/);
  assert.doesNotMatch(step.run, /set\s+-x/);
}

function assertProtectedDemoRuntimeInventory(step, submissionEnabled = "false") {
  assert.match(step.run, /captcha_server_key="ysc2_\$\(openssl rand -hex 24\)"/);
  assert.ok(step.run.includes('"$captcha_server_key"'));
  for (const [variable, value] of Object.entries({
    LANDING_DEMO_SUBMISSION_ENABLED: submissionEnabled,
    LANDING_ORIGIN: "https://landing.localhost:18443",
    LANDING_DEMO_RECIPIENT: "demo-recipient@markiro.local",
    LANDING_DEMO_REPLY_TO: "demo-reply-to@markiro.local",
    SMARTCAPTCHA_SERVER_KEY: "$captcha_server_key",
  })) {
    assert.ok(step.run.includes(`"${variable}=${value}"`), `${variable} must use the env file`);
  }
}

test("CI keeps production bundle, Yandex runtime and infrastructure contracts", async () => {
  const [workflow, source] = await Promise.all([
    parse(".github/workflows/ci.yml"),
    read(".github/workflows/ci.yml"),
  ]);
  for (const command of ["test:production-bundle:contract", "test:yandex-runtime"])
    assert.match(source, new RegExp(command.replaceAll(":", "\\:")));
  assert.match(source, /pnpm format:check/);
  for (const variable of ["PLATFORM_AUTH_SECRET", "PLATFORM_AUTH_URL", "SAAS_ADMIN_ORIGIN"])
    assert.match(source, new RegExp(variable));
  assert.match(source, /MARKIRO_SAAS_ADMIN_DOMAIN:\s*saas-admin\.localhost/);
  assert.match(source, /MARKIRO_LANDING_DOMAIN:\s*landing\.localhost/);
  assertNoRetiredLegalEnvironmentVariables(source);
  assertProtectedDemoRuntimeInventory(
    namedStep(workflow, "production-bundle", "Generate masked test-only environment"),
  );
  assertEdgeBuildStep(
    namedStep(workflow, "production-bundle", "Build local SHA-tagged production images"),
    Object.fromEntries(
      publicLandingBuildVariables.map((variable) => [
        variable,
        variable === "PUBLIC_DEMO_SUBMISSION_ENABLED" ? "false" : "",
      ]),
    ),
  );
});

test("CI validates the edge image before landing browser gates", async () => {
  const workflow = await parse(".github/workflows/ci.yml");
  const steps = workflow.jobs["production-bundle"].steps;
  const step = namedStep(
    workflow,
    "production-bundle",
    "Verify landing browser and Lighthouse release gates",
  );
  const stepIndex = steps.indexOf(step);
  const imageBuildIndex = steps.indexOf(
    namedStep(workflow, "production-bundle", "Build local SHA-tagged production images"),
  );
  assert.ok(imageBuildIndex < stepIndex, "the PDF/A-validating edge build must precede browsers");
  assert.match(step.run, /^pnpm test:landing:browser\npnpm test:landing:lighthouse\n?$/);
  assert.equal(step.env, undefined);
});

test("CI builds legal verifier dependencies immediately before production contracts", async () => {
  assertLegalVerifierBuildsImmediatelyBeforeProductionContracts(
    await parse(".github/workflows/ci.yml"),
  );
});

test("release publication is main-only, digest-bound and writes the immutable manifest", async () => {
  const [workflow, source] = await Promise.all([
    parse(".github/workflows/release-images.yml"),
    read(".github/workflows/release-images.yml"),
  ]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.jobs["production-bundle"].permissions.contents, "read");
  assert.match(source, /markiro-api/);
  assert.match(source, /markiro-edge/);
  assert.match(source, /release-manifest\.mjs|manifest\.json/);
  assert.match(source, /markiro-release-manifest-\$\{\{/);
  assert.doesNotMatch(source, /:latest\b/);
  for (const variable of ["PLATFORM_AUTH_SECRET", "PLATFORM_AUTH_URL", "SAAS_ADMIN_ORIGIN"])
    assert.match(source, new RegExp(variable));
  assert.match(source, /MARKIRO_SAAS_ADMIN_DOMAIN:\s*saas-admin\.localhost/);
  assert.match(source, /MARKIRO_LANDING_DOMAIN:\s*landing\.localhost/);
  assertNoRetiredLegalEnvironmentVariables(source);
  const runtimeStep = namedStep(
    workflow,
    "production-bundle",
    "Generate masked test-only environment",
  );
  assert.deepEqual(runtimeStep.env, {
    LANDING_DEMO_SUBMISSION_ENABLED:
      "${{ vars.PUBLIC_DEMO_SUBMISSION_ENABLED == 'true' && 'true' || 'false' }}",
  });
  assertProtectedDemoRuntimeInventory(runtimeStep, "$LANDING_DEMO_SUBMISSION_ENABLED");
  const smokeStep = namedStep(workflow, "production-bundle", "Smoke the production bundle");
  assert.equal(
    smokeStep.env.MARKIRO_LANDING_DEMO_SUBMISSION_STATE,
    "${{ vars.PUBLIC_DEMO_SUBMISSION_ENABLED == 'true' && 'enabled' || 'disabled' }}",
  );
  assertEdgeBuildStep(
    namedStep(workflow, "production-bundle", "Build local SHA-tagged production images"),
    Object.fromEntries(
      publicLandingBuildVariables.map((variable) => [variable, "${{ vars." + variable + " }}"]),
    ),
  );
});

test("release image cleanup survives downstream evidence failures after a successful publish", async () => {
  const workflow = await parse(".github/workflows/release-images.yml");
  const steps = workflow.jobs.publish.steps;
  const publish = namedStep(workflow, "publish", "Publish the exact verified production images");
  const cleanup = namedStep(
    workflow,
    "publish",
    "Delete the verified images artifact after publish",
  );

  assert.ok(steps.indexOf(publish) < steps.indexOf(cleanup));
  assert.equal(cleanup.if, "${{ always() && steps.published-images.outcome == 'success' }}");
});

test("release builds legal verifier dependencies immediately before production contracts", async () => {
  assertLegalVerifierBuildsImmediatelyBeforeProductionContracts(
    await parse(".github/workflows/release-images.yml"),
  );
});

test("demo server settings stay in the protected API environment file", async () => {
  const [productionCompose, ciCompose] = await Promise.all([
    parse("compose.production.yml"),
    parse("deploy/production/compose.ci.yml"),
  ]);
  assert.deepEqual(productionCompose.services.api.env_file, [
    "${MARKIRO_ENV_FILE:-.env.production}",
  ]);
  for (const service of [
    ...Object.values(productionCompose.services),
    ...Object.values(ciCompose.services),
  ]) {
    const composeArguments = JSON.stringify({
      command: service.command,
      environment: service.environment,
    });
    for (const variable of demoRuntimeVariables) {
      assert.doesNotMatch(composeArguments, new RegExp(variable));
    }
  }
});

test("production deploy is one protected manual GitHub-hosted SSH job", async () => {
  const [workflow, source] = await Promise.all([
    parse(".github/workflows/deploy-production.yml"),
    read(".github/workflows/deploy-production.yml"),
  ]);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "release_run_id",
    "release_sha",
    "landing_demo_submission_state",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.landing_demo_submission_state, {
    description: "Expected API demo-submission state during public smoke",
    required: true,
    type: "choice",
    options: ["disabled", "enabled"],
  });
  assert.deepEqual(Object.keys(workflow.jobs), ["deploy"]);
  const deploy = workflow.jobs.deploy;
  assert.equal(deploy["runs-on"], "ubuntu-latest");
  assert.equal(deploy.environment, "production-deploy");
  assert.deepEqual(deploy.permissions, { actions: "read", contents: "read", packages: "read" });
  assert.match(source, /release-manifest\.mjs validate/);
  assert.match(source, /remote-deploy\.mjs run/);
  assert.match(source, /YC_APP_DEPLOY_SSH_PRIVATE_KEY/);
  assert.match(source, /APP_SSH_HOST_KEYS_B64/);
  assert.match(source, /ACME_EMAIL:\s*\$\{\{ vars\.ACME_EMAIL \}\}/);
  assert.match(source, /MARKIRO_SAAS_ADMIN_DOMAIN:\s*\$\{\{ vars\.MARKIRO_SAAS_ADMIN_DOMAIN \}\}/);
  assert.match(source, /MARKIRO_LANDING_DOMAIN:\s*\$\{\{ vars\.MARKIRO_LANDING_DOMAIN \}\}/);
  assert.match(
    source,
    /MARKIRO_LANDING_DEMO_SUBMISSION_STATE:\s*\$\{\{ inputs\.landing_demo_submission_state \}\}/,
  );
  assert.match(source, /GHCR_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.match(source, /if:\s*always\(\)/);
  assert.doesNotMatch(
    source,
    /workflow_run|self-hosted|id-token|deployment_phase|rollback_rehearsal|production-controller|production-cleanup|YC_IAM|YC_LOAD_BALANCER/i,
  );
});

test("v-b deploy is a protected manual digest-bound private executor", async () => {
  const [workflow, source] = await Promise.all([
    parse(".github/workflows/deploy-vbtech-production.yml"),
    read(".github/workflows/deploy-vbtech-production.yml"),
  ]);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "vbtech_release_sha",
    "vbtech_image_digest",
    "submission_state",
    "confirm_private_deploy",
    "confirm_enable",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.submission_state.options, [
    "disabled",
    "enabled",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm_private_deploy.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm_private_deploy.type, "boolean");
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, {
    group: "markiro-production-deployment",
    "cancel-in-progress": false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), ["deploy"]);
  const deploy = workflow.jobs.deploy;
  assert.equal(deploy["runs-on"], "ubuntu-latest");
  assert.equal(deploy.environment, "production-deploy");
  assert.deepEqual(deploy.permissions, {
    attestations: "read",
    contents: "read",
    packages: "read",
  });
  assert.ok(Number.isSafeInteger(deploy["timeout-minutes"]));
  assert.ok(deploy["timeout-minutes"] > 0 && deploy["timeout-minutes"] <= 60);

  const preflight = namedStep(workflow, "deploy", "Validate private deploy request");
  assert.ok(
    deploy.if === "${{ inputs.confirm_private_deploy == true }}" ||
      /\[\[ "\$CONFIRM_PRIVATE_DEPLOY" == "true" \]\]/.test(preflight.run),
  );
  const verification = namedStep(workflow, "deploy", "Verify exact attested v-b image");
  const keyCreation = namedStep(workflow, "deploy", "Create protected SSH identity");
  const before = namedStep(workflow, "deploy", "Capture before runtime diagnostics");
  const delivery = namedStep(workflow, "deploy", "Deploy private v-b image");
  const after = namedStep(workflow, "deploy", "Capture after runtime diagnostics");
  assert.ok(deploy.steps.indexOf(verification) < deploy.steps.indexOf(keyCreation));
  assert.ok(deploy.steps.indexOf(keyCreation) < deploy.steps.indexOf(before));
  assert.ok(deploy.steps.indexOf(before) < deploy.steps.indexOf(delivery));
  assert.ok(deploy.steps.indexOf(delivery) < deploy.steps.indexOf(after));
  assert.match(verification.run, /gh attestation verify "oci:\/\/\$image_ref"/);
  assert.match(verification.run, /docker manifest inspect "\$image_ref" > \/dev\/null/);
  assert.match(delivery.run, /remote-vbtech-deploy[.]mjs run/);
  assert.doesNotMatch(delivery.run, /remote-deploy[.]mjs run/);
  assert.match(source, /MARKIRO_SAAS_ADMIN_DOMAIN:\s*\$\{\{ vars\.MARKIRO_SAAS_ADMIN_DOMAIN \}\}/);
  assert.match(before.run, /runtime-diagnostics[.]mjs run/);
  assert.match(after.run, /runtime-diagnostics[.]mjs run/);
  assert.match(source, /ghcr[.]io\/thevladbog\/vbtech-web/);
  assert.match(source, /thevladbog\/v-b\/.github\/workflows\/publish[.]yml/);
  assert.match(source, /refs\/heads\/main/);
  assert.match(source, /VBTECH_SUBMISSION_STATE:\s*\$\{\{ inputs\.submission_state \}\}/);
  assert.match(source, /identity\.consentId !== "VBT-PD-02\/2026\.08\/01"/);
  assert.match(source, /CONFIRM_ENABLE[\s\S]*== "true"/);
  assert.match(source, /if:\s*always\(\)/);
  assert.doesNotMatch(
    source,
    /workflow_run|self-hosted|id-token:\s*write|\byc\s|terraform|psql|postgres(?:ql)?|cloud function|function create|\bvpc\b|lockbox|bucket|service-account|smartcaptcha|postbox|external form|scp|rsync/i,
  );
});

test("infrastructure workflow passes the SaaS admin and landing domains to Terraform", async () => {
  const source = await read(".github/workflows/yandex-infrastructure.yml");
  assert.match(source, /TF_VAR_saas_admin_domain:\s*\$\{\{ vars\.MARKIRO_SAAS_ADMIN_DOMAIN \}\}/);
  assert.match(source, /TF_VAR_landing_domain:\s*\$\{\{ vars\.MARKIRO_LANDING_DOMAIN \}\}/);
});

test("retired DNS and post-DNS workflows are absent", async () => {
  for (const path of [
    ".github/workflows/yandex-dns-convergence.yml",
    ".github/workflows/yandex-post-dns-smoke.yml",
  ])
    await assert.rejects(access(new URL(path, root)));
});

test("all third-party actions in active production workflows are commit pinned", async () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/release-images.yml",
    ".github/workflows/deploy-production.yml",
    ".github/workflows/deploy-vbtech-production.yml",
    ".github/workflows/yandex-infrastructure.yml",
    ".github/workflows/station-beta-release.yml",
  ]) {
    const source = await read(path);
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      assert.match(match[1], /^[^@]+@[0-9a-f]{40}$/, path);
    }
  }
});
