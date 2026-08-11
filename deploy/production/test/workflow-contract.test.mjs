import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { load } from "js-yaml";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const parse = async (path) => load(await read(path));

test("CI keeps production bundle, Yandex runtime and infrastructure contracts", async () => {
  const source = await read(".github/workflows/ci.yml");
  for (const command of ["test:production-bundle:contract", "test:yandex-runtime"])
    assert.match(source, new RegExp(command.replaceAll(":", "\\:")));
  assert.match(source, /pnpm format:check/);
});

test("release publication is main-only, digest-bound and writes the immutable manifest", async () => {
  const [workflow, source] = await Promise.all([
    parse(".github/workflows/release-images.yml"),
    read(".github/workflows/release-images.yml"),
  ]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.jobs.publish.permissions.packages, "write");
  assert.match(source, /markiro-api/);
  assert.match(source, /markiro-edge/);
  assert.match(source, /release-manifest\.mjs/);
  assert.match(source, /markiro-release-manifest-\$\{\{/);
  assert.doesNotMatch(source, /:latest\b/);
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
  ]);
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
  assert.match(source, /GHCR_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.match(source, /if:\s*always\(\)/);
  assert.doesNotMatch(
    source,
    /workflow_run|self-hosted|id-token|deployment_phase|rollback_rehearsal|production-controller|production-cleanup|YC_IAM|YC_LOAD_BALANCER/i,
  );
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
