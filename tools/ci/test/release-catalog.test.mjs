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

test("every fresh catalog workflow builds the domain dependency before contracts", () => {
  for (const file of [
    "ci.yml",
    "station-beta-release.yml",
    "station-stable-release.yml",
    "station-release-reseed.yml",
    "handheld-release.yml",
    "handheld-stable-release.yml",
    "standalone-stable-release.yml",
  ]) {
    const workflow = load(readFileSync(`.github/workflows/${file}`, "utf8"));
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const commands = job.steps?.map((s) => s.run ?? "").join("\n") ?? "";
      const contracts = commands.indexOf("pnpm --filter @markiro/platform-contracts build");
      if (contracts < 0) continue;
      const earlier = commands.slice(0, contracts);
      assert.ok(
        earlier.includes("pnpm --filter @markiro/domain build") ||
          earlier.includes("pnpm turbo run build --filter=@markiro/domain"),
        `${file}/${name}: missing earlier domain build`,
      );
    }
  }
});
test("handheld sync-download builds the compiled catalog verifier before loading it", () => {
  const workflow = load(readFileSync(".github/workflows/handheld-release.yml", "utf8"));
  const commands = workflow.jobs["sync-download"].steps.map((s) => s.run ?? "").join("\n");
  const run = commands.indexOf("node tools/handheld-release/download.mjs");
  const before = commands.slice(0, run);
  assert.ok(run >= 0);
  assert.ok(before.includes("pnpm --filter @markiro/domain build"));
  assert.ok(before.includes("pnpm --filter @markiro/platform-contracts build"));
});

test("stable publishers prepare a verified runtime without publisher credentials", () => {
  const prepareAction = "./.github/actions/prepare-publisher-runtime";
  const restoreAction = "./.github/actions/restore-publisher-runtime";
  for (const product of ["handheld", "standalone"]) {
    const workflow = load(readFileSync(`.github/workflows/${product}-stable-release.yml`, "utf8"));
    assert.equal(workflow["cache-mode"], "none");
    assert.notEqual(workflow.permissions?.["id-token"], "write");
    const prepare = workflow.jobs["prepare-runtime"];
    assert.ok(prepare, product);
    assert.deepEqual(prepare.permissions, { contents: "read" });
    assert.equal(prepare.environment, undefined);
    assert.doesNotMatch(JSON.stringify(prepare), /secrets\.|inputs\.|needs\./u);
    assert.ok(prepare.if.includes(`refs/tags/${product}-publisher-v1`));
    assert.ok(prepare.if.includes("github.actor == github.repository_owner"));
    assert.ok(prepare.if.includes("github.triggering_actor == github.repository_owner"));
    assert.equal(prepare.steps[0].with.ref, "${{ github.sha }}");
    assert.equal(prepare.steps.at(-1).uses, prepareAction);
    for (const name of ["publish", "verify"]) {
      const job = workflow.jobs[name];
      assert.ok([job.needs].flat().includes("prepare-runtime"));
      assert.doesNotMatch(JSON.stringify(job), /pnpm install|pnpm --filter|corepack enable/u);
      const restore = job.steps.find((step) => step.uses === restoreAction);
      assert.deepEqual(restore?.with, {
        "artifact-id": "${{ needs.prepare-runtime.outputs.artifact_id }}",
        sha256: "${{ needs.prepare-runtime.outputs.sha256 }}",
      });
      const usesCatalog = job.steps.findIndex((step) =>
        /node tools\/(?:standalone-release\/publish-catalog|handheld-release\/publish|release-catalog\/verify-stable)\.mjs/u.test(
          step.run ?? "",
        ),
      );
      assert.ok(usesCatalog > job.steps.indexOf(restore));
    }
  }

  const readAction = (name) => load(readFileSync(`${name}/action.yml`, "utf8")).runs.steps;
  const prepare = readAction(prepareAction);
  const commands = prepare.map((step) => step.run ?? "").join("\n");
  assert.match(commands, /install --frozen-lockfile --ignore-scripts/u);
  assert.match(commands, /@markiro\/domain build[\s\S]*@markiro\/platform-contracts build/u);
  assert.match(commands, /runtime-archive\.py pack/u);
  assert.doesNotMatch(JSON.stringify(prepare), /secrets\.|id-token/u);
  const restore = readAction(restoreAction);
  assert.doesNotMatch(JSON.stringify(restore), /pnpm|npm install|secrets\./u);
  const download = restore.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with["artifact-ids"], "${{ inputs.artifact-id }}");
  assert.equal(download.with["digest-mismatch"], "error");
  assert.match(restore.at(-1).run, /runtime-archive\.py restore .*"\$RUNTIME_SHA256"/u);
  for (const step of [...prepare, ...restore]) {
    if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/u);
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{/u);
  }
});

test("validator packaging test schedules its own build on a clean runner", () => {
  const dry = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "node_modules/turbo/bin/turbo",
        "run",
        "test",
        "--filter=@markiro/release-validation",
        "--dry=json",
      ],
      { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  const task = dry.tasks.find((t) => t.taskId === "@markiro/release-validation#test");
  assert.ok(task);
  assert.ok(
    task.dependencies.includes("@markiro/release-validation#build"),
    "packaging test requires its own generated runtime",
  );
});
