import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { load } from "js-yaml";

import { assertLegalVerifierBuildsImmediatelyBeforeProductionContracts } from "./helpers/workflow-contract.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const parse = async (path) => load(await read(path));
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

// The Yandex runtime is retired (owner decision 2026-10-21): CI keeps this
// contract suite, which the platform release re-runs, and drops the legacy
// image, Compose smoke and documentation smoke; the Yandex release and deploy
// workflows themselves are gone too.
test("CI keeps the production contracts but no longer runs the retired Yandex contour", async () => {
  const [workflow, source] = await Promise.all([
    parse(".github/workflows/ci.yml"),
    read(".github/workflows/ci.yml"),
  ]);
  for (const command of ["test:production-bundle:contract", "test:indexnow"])
    assert.match(source, new RegExp(command.replaceAll(":", "\\:")));
  assert.match(source, /pnpm format:check/);
  for (const variable of ["PLATFORM_AUTH_SECRET", "PLATFORM_AUTH_URL", "SAAS_ADMIN_ORIGIN"])
    assert.match(source, new RegExp(variable));
  assertNoRetiredLegalEnvironmentVariables(source);
  for (const retired of [
    "test:yandex-runtime",
    "test:production-docs:browser",
    "deploy/production/edge.Dockerfile",
    "deploy/production/smoke.mjs",
    "compose.production.yml",
  ])
    assert.ok(!source.includes(retired), retired);
  // The platform edge is built with its defaults: the demo form off, no keys.
  const edge = namedStep(
    workflow,
    "production-bundle",
    "Build local platform-only edge preparation image",
  );
  assert.equal(edge.with.file, "deploy/platform/edge.Dockerfile");
  assert.equal(edge.with["build-args"], undefined);
  assert.equal(edge.env, undefined);
});

test("ci.yml runs platform contracts without an ambient Compose project", async () => {
  const workflow = await parse(".github/workflows/ci.yml");
  assert.equal(workflow.jobs["production-bundle"].env, undefined);
  assert.equal(
    namedStep(workflow, "production-bundle", "Verify portable platform preparation contracts").run,
    "env -u COMPOSE_PROJECT_NAME node --test deploy/platform/test/*.test.mjs",
  );
});

test("CI builds legal verifier dependencies immediately before production contracts", async () => {
  assertLegalVerifierBuildsImmediatelyBeforeProductionContracts(
    await parse(".github/workflows/ci.yml"),
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

test("retired Yandex release, deploy, DNS and post-DNS workflows are absent", async () => {
  for (const path of [
    ".github/workflows/release-images.yml",
    ".github/workflows/deploy-production.yml",
    ".github/workflows/yandex-dns-convergence.yml",
    ".github/workflows/yandex-post-dns-smoke.yml",
  ])
    await assert.rejects(access(new URL(path, root)));
});

test("all third-party actions in active production workflows are commit pinned", async () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/release-platform-images.yml",
    ".github/workflows/deploy-platform.yml",
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
