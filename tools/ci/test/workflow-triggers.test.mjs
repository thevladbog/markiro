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
    "deploy-production.yml": ["workflow_dispatch"],
    "deploy-vbtech-production.yml": ["workflow_dispatch"],
    "diagnose-production.yml": ["workflow_dispatch"],
    "provision-platform-admin.yml": ["workflow_dispatch"],
    "release-images.yml": ["push"],
    "signer-download-repair.yml": ["workflow_dispatch"],
    "signer-stable-release.yml": ["workflow_dispatch"],
    "station-beta-release.yml": ["workflow_dispatch"],
    "station-stable-release.yml": ["workflow_dispatch"],
    "yandex-infrastructure.yml": ["pull_request", "workflow_dispatch"],
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

test("production image publication runs only for deployable image and release inputs", () => {
  const value = workflow("release-images.yml");

  assert.deepEqual(value.on.push, {
    branches: ["main"],
    paths: [
      ".github/workflows/release-images.yml",
      ".dockerignore",
      ".npmrc",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "turbo.json",
      "tsconfig.base.json",
      "patches/**",
      "apps/api/**",
      "apps/admin/**",
      "apps/kiosk/**",
      "apps/landing/**",
      "apps/saas-admin/**",
      "packages/db/**",
      "packages/domain/**",
      "packages/email/**",
      "packages/legal-documents/**",
      "packages/platform-contracts/**",
      "packages/ui/**",
      "compose.production.yml",
      "deploy/production/**",
      "deploy/yandex/**",
      "tools/production-browser/**",
    ],
  });
});

test("Yandex pull-request validation runs only for infrastructure contract changes", () => {
  const value = workflow("yandex-infrastructure.yml");

  assert.deepEqual(value.on.pull_request, {
    branches: ["main"],
    paths: [
      ".github/workflows/yandex-infrastructure.yml",
      ".github/workflows/deploy-production.yml",
      ".github/workflows/deploy-vbtech-production.yml",
      ".npmrc",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "patches/**",
      "compose.production.yml",
      "deploy/production/**",
      "deploy/yandex/**",
      "infra/yandex/**",
      "docs/runbooks/saas-production-deploy.md",
      "docs/runbooks/yandex-*.md",
      "docs/superpowers/plans/2026-08-09-yandex-direct-vm-mvp.md",
      "docs/superpowers/specs/2026-08-09-yandex-direct-vm-mvp-design.md",
    ],
  });
  assert.deepEqual(value.concurrency, {
    group:
      "${{ github.event_name == 'pull_request' && format('markiro-yandex-pr-{0}', github.event.pull_request.number) || 'markiro-yandex-production-state' }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
});
