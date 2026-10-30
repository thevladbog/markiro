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
  assert.equal(workflow.jobs["platform-contracts"].env, undefined);
  assert.equal(
    namedStep(workflow, "platform-contracts", "Verify portable platform preparation contracts").run,
    "env -u COMPOSE_PROJECT_NAME node --test --test-shard=${{ matrix.shard }}/2 deploy/platform/test/*.test.mjs",
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

test("retired Yandex release, deploy, infrastructure and diagnostics workflows are absent", async () => {
  // Yandex Cloud is gone (2026-10-22): its Terraform, host runtime and every
  // workflow that reached the old VM were removed with it.
  for (const path of [
    ".github/workflows/release-images.yml",
    ".github/workflows/deploy-production.yml",
    ".github/workflows/yandex-dns-convergence.yml",
    ".github/workflows/yandex-post-dns-smoke.yml",
    ".github/workflows/yandex-infrastructure.yml",
    ".github/workflows/diagnose-production.yml",
    ".github/workflows/deploy-vbtech-production.yml",
    ".github/workflows/provision-platform-admin.yml",
    "infra/yandex",
    "deploy/yandex",
  ])
    await assert.rejects(access(new URL(path, root)));
});

test("all third-party actions in active production workflows are commit pinned", async () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/release-platform-images.yml",
    ".github/workflows/deploy-platform.yml",
    ".github/workflows/station-beta-release.yml",
  ]) {
    const source = await read(path);
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      assert.match(match[1], /^[^@]+@[0-9a-f]{40}$/, path);
    }
  }
});

test("new main pushes queue instead of cancelling an executor CI; PR updates still cancel stale checks", async () => {
  const workflow = await parse(".github/workflows/ci.yml");
  assert.equal(workflow.concurrency.group, "ci-${{ github.ref }}");
  assert.equal(
    workflow.concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
  );
});
