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

function assertProtectedDemoRuntimeInventory(step) {
  assert.match(step.run, /captcha_server_key="ysc2_\$\(openssl rand -hex 24\)"/);
  assert.ok(step.run.includes('"$captcha_server_key"'));
  for (const [variable, value] of Object.entries({
    LANDING_DEMO_SUBMISSION_ENABLED: "false",
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
  assert.match(source, /MARKIRO_LANDING_DOMAIN:\s*landing\.localhost/);
  assertNoRetiredLegalEnvironmentVariables(source);
  assertProtectedDemoRuntimeInventory(
    namedStep(workflow, "production-bundle", "Generate masked test-only environment"),
  );
  assertEdgeBuildStep(
    namedStep(workflow, "production-bundle", "Build local SHA-tagged production images"),
    Object.fromEntries(
      publicLandingBuildVariables.map((variable) => [variable, "${{ vars." + variable + " }}"]),
    ),
  );
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

test("infrastructure workflow passes the landing domain to Terraform", async () => {
  const source = await read(".github/workflows/yandex-infrastructure.yml");
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
    ".github/workflows/yandex-infrastructure.yml",
    ".github/workflows/station-beta-release.yml",
  ]) {
    const source = await read(path);
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      assert.match(match[1], /^[^@]+@[0-9a-f]{40}$/, path);
    }
  }
});
