import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import { classifyChangedFiles } from "../affected.mjs";
const required = [
  "verify_static",
  "verify_api_tests",
  "verify_app_tests",
  "production_bundle",
  "platform_contracts",
  "station_windows_build",
  "handheld_android",
  "standalone_windows_build",
  "signer_windows_build",
];
test("catalog and canonical validator changes select every affected consumer without fallback", () => {
  for (const path of [
    "tools/release-catalog/client.mjs",
    "packages/release-validation/build.mjs",
    "packages/platform-contracts/src/release-catalog.ts",
    "packages/platform-contracts/src/release-history.ts",
    "packages/db/src/schema/release-catalog.ts",
    "apps/api/src/modules/release-catalog/catalog-service.ts",
    "deploy/platform/Caddyfile",
    "deploy/platform/backup/catalog.mjs",
    "deploy/platform/compose.catalog.yml",
    "tools/signer-release/artifacts.mjs",
    "tools/station-release/artifacts.mjs",
  ]) {
    const result = classifyChangedFiles([path]);
    assert.equal(result.full, false, path);
    for (const job of required) assert.equal(result.jobs[job], true, `${path}: ${job}`);
  }
});
test("required API job owns compiled catalog contracts and real isolated dump restore without skips", () => {
  const workflow = load(readFileSync(".github/workflows/ci.yml", "utf8")),
    job = workflow.jobs["verify-api-tests"];
  const prepare = job.steps.find((s) => s.name === "Prepare isolated release catalog PostgreSQL");
  assert.ok(prepare);
  for (const text of [
    "127.0.0.1:33791:5432",
    "markiro-release-catalog-test-20261024",
    "markiro.task=immutable-release-catalog-20261024",
    "CATALOG_TEST_DATABASE_URL",
    "catalog_test",
  ])
    assert.ok(prepare.run.includes(text), text);
  const gate = job.steps.find((s) => s.name === "Verify release catalog and actual recovery");
  assert.ok(gate);
  for (const text of [
    "@markiro/api build",
    "test:release-catalog:contract",
    "backup-catalog-postgres.test.mjs",
    "release-catalog-*.integration.test.ts",
    "standalone-releases.e2e.test.ts",
  ])
    assert.ok(gate.run.includes(text), text);
  assert.ok(job.steps.indexOf(gate) > job.steps.indexOf(prepare));
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(gate["continue-on-error"], undefined);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(
    pkg.scripts["test:release-catalog:contract"],
    "node --test tools/release-catalog/test/*.test.mjs",
  );
});

test("release client contracts build their shared schemas on fresh checkouts", () => {
  for (const [file, jobName, marker] of [
    ["ci.yml", "verify-static", "pnpm test:handheld-release:contract"],
    ["ci.yml", "station-windows-build", "pnpm test:station-release:contract"],
    ["station-stable-release.yml", "build", "pnpm test:station-release:contract"],
  ]) {
    const w = load(readFileSync(`.github/workflows/${file}`, "utf8"));
    const steps = w.jobs[jobName].steps;
    const index = steps.findIndex((s) => s.run?.includes(marker));
    assert.ok(index >= 0);
    const before = steps
      .slice(0, index + 1)
      .map((s) => s.run ?? "")
      .join("\n")
      .split(marker)[0];
    assert.ok(
      before.includes("pnpm --filter @markiro/platform-contracts build"),
      `${file}/${jobName}`,
    );
  }
});

test("synthetic platform CI never inherits production catalog bind paths", () => {
  const overlay = readFileSync("deploy/platform/compose.ci.yml", "utf8");
  assert.match(overlay, /api:[\s\S]*?volumes: !override \[\]/u);
  const harness = readFileSync("deploy/platform/ci-stack.mjs", "utf8");
  assert.match(harness, /assert\.deepEqual\(config\.services\.api\.volumes \?\? \[\], \[\]\)/u);
});
test("catalog CI waits for PostgreSQL final TCP listener", () => {
  const workflow = load(readFileSync(".github/workflows/ci.yml", "utf8"));
  const prepare = workflow.jobs["verify-api-tests"].steps.find(
    (s) => s.name === "Prepare isolated release catalog PostgreSQL",
  );
  assert.match(prepare.run, /pg_isready -h 127\.0\.0\.1 -U postgres -d catalog_test/u);
});

test("Turbo hashes canonical validator sources outside the packaging workspace", () => {
  const dry = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "node_modules/turbo/bin/turbo",
        "run",
        "build",
        "--filter=@markiro/release-validation",
        "--dry=json",
      ],
      { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  const task = dry.tasks.find((t) => t.taskId === "@markiro/release-validation#build");
  assert.ok(task);
  for (const path of [
    "station-release/artifacts.mjs",
    "station-release/origins.mjs",
    "station-release/version.mjs",
    "handheld-release/manifest.mjs",
    "signer-release/artifacts.mjs",
    "signer-release/manifest.mjs",
    "signer-release/version.mjs",
  ])
    assert.ok(
      Object.keys(task.inputs).some((key) => key.endsWith(`tools/${path}`)),
      path,
    );
  assert.ok(Object.hasOwn(task.inputs, "build.mjs"), "default package inputs remain included");
});
