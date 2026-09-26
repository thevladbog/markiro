import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { load } from "js-yaml";

const workflow = load(readFileSync(".github/workflows/ci.yml", "utf8"));

const heavyJobs = [
  ["verify-static", "verify_static"],
  ["verify-api-tests", "verify_api_tests"],
  ["verify-app-tests", "verify_app_tests"],
  ["tenant-team-infrastructure", "tenant_team_infrastructure"],
  ["production-bundle", "production_bundle"],
  ["station-rust", "station_rust"],
  ["station-windows-build", "station_windows_build"],
  ["signer-rust", "signer_rust"],
  ["signer-windows-build", "signer_windows_build"],
  ["handheld-android", "handheld_android"],
];

function stepByName(job, name) {
  return job.steps.find((step) => step.name === name);
}

test("classifier uses exact pull-request and main-push diffs and exposes every policy output", () => {
  const classifier = workflow.jobs["classify-changes"];
  assert.ok(classifier, "workflow must define classify-changes");

  const checkout = classifier.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkout, "classifier must check out the repository");
  assert.equal(checkout.with["fetch-depth"], 0);

  const classifyStep = classifier.steps.find((step) => step.id === "affected");
  assert.ok(classifyStep, "classifier must expose the affected step");
  assert.equal(classifyStep.env.EVENT_NAME, "${{ github.event_name }}");
  assert.equal(classifyStep.env.PR_BASE_SHA, "${{ github.event.pull_request.base.sha }}");
  assert.equal(classifyStep.env.PR_HEAD_SHA, "${{ github.event.pull_request.head.sha }}");
  assert.equal(classifyStep.env.PUSH_BEFORE_SHA, "${{ github.event.before }}");
  assert.equal(classifyStep.env.PUSH_HEAD_SHA, "${{ github.sha }}");
  assert.match(classifyStep.run, /EVENT_NAME" == "pull_request"/);
  assert.match(classifyStep.run, /EVENT_NAME" == "push"/);
  assert.match(classifyStep.run, /diff_base="\$PR_BASE_SHA"/);
  assert.match(classifyStep.run, /diff_head="\$PR_HEAD_SHA"/);
  assert.match(classifyStep.run, /diff_base="\$PUSH_BEFORE_SHA"/);
  assert.match(classifyStep.run, /diff_head="\$PUSH_HEAD_SHA"/);
  assert.match(
    classifyStep.run,
    /git diff --name-only --no-renames -z "\$diff_base" "\$diff_head"/,
  );
  assert.match(classifyStep.run, /affected\.mjs --stdin-zero/);
  assert.match(classifyStep.run, /affected\.mjs --full/);

  for (const output of ["full", ...heavyJobs.map(([, name]) => name)]) {
    assert.equal(classifier.outputs[output], `\${{ steps.affected.outputs.${output} }}`, output);
  }
});

test("classifier falls back to a full run when pull-request diff generation fails", (t) => {
  const classifier = workflow.jobs["classify-changes"];
  const classifyStep = classifier.steps.find((step) => step.id === "affected");
  const directory = mkdtempSync(join(tmpdir(), "markiro-ci-workflow-"));
  const binaryDirectory = join(directory, "bin");
  const outputPath = join(directory, "github-output.txt");
  const gitPath = join(binaryDirectory, "git");

  t.after(() => rmSync(directory, { force: true, recursive: true }));
  mkdirSync(binaryDirectory);
  writeFileSync(gitPath, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  chmodSync(gitPath, 0o755);

  const child = spawnSync("bash", ["-c", classifyStep.run], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: outputPath,
      PR_BASE_SHA: "a".repeat(40),
      PR_HEAD_SHA: "b".repeat(40),
      PUSH_BEFORE_SHA: "",
      PUSH_HEAD_SHA: "",
      PATH: `${binaryDirectory}:${process.env.PATH}`,
    },
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    readFileSync(outputPath, "utf8"),
    ["full=true", ...heavyJobs.map(([, name]) => `${name}=true`), ""].join("\n"),
  );
});

test("classifier applies the changed-file policy to an existing main push", (t) => {
  const classifier = workflow.jobs["classify-changes"];
  const classifyStep = classifier.steps.find((step) => step.id === "affected");
  const directory = mkdtempSync(join(tmpdir(), "markiro-ci-push-workflow-"));
  const binaryDirectory = join(directory, "bin");
  const outputPath = join(directory, "github-output.txt");
  const gitPath = join(binaryDirectory, "git");

  t.after(() => rmSync(directory, { force: true, recursive: true }));
  mkdirSync(binaryDirectory);
  writeFileSync(gitPath, "#!/usr/bin/env bash\nprintf 'docs/architecture.md\\0'\n", {
    mode: 0o755,
  });
  chmodSync(gitPath, 0o755);

  const child = spawnSync("bash", ["-c", classifyStep.run], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT_NAME: "push",
      GITHUB_OUTPUT: outputPath,
      PR_BASE_SHA: "",
      PR_HEAD_SHA: "",
      PUSH_BEFORE_SHA: "c".repeat(40),
      PUSH_HEAD_SHA: "d".repeat(40),
      PATH: `${binaryDirectory}:${process.env.PATH}`,
    },
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    readFileSync(outputPath, "utf8"),
    ["full=false", ...heavyJobs.map(([, name]) => `${name}=false`), ""].join("\n"),
  );
});

test("classifier fails closed for a push without a usable previous commit", (t) => {
  const classifier = workflow.jobs["classify-changes"];
  const classifyStep = classifier.steps.find((step) => step.id === "affected");
  const directory = mkdtempSync(join(tmpdir(), "markiro-ci-new-push-workflow-"));
  const outputPath = join(directory, "github-output.txt");

  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const child = spawnSync("bash", ["-c", classifyStep.run], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT_NAME: "push",
      GITHUB_OUTPUT: outputPath,
      PR_BASE_SHA: "",
      PR_HEAD_SHA: "",
      PUSH_BEFORE_SHA: "0".repeat(40),
      PUSH_HEAD_SHA: "e".repeat(40),
    },
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    readFileSync(outputPath, "utf8"),
    ["full=true", ...heavyJobs.map(([, name]) => `${name}=true`), ""].join("\n"),
  );
});

test("every heavy job keeps its id and is gated by its classifier output", () => {
  for (const [jobId, outputName] of heavyJobs) {
    const job = workflow.jobs[jobId];
    assert.ok(job, `workflow must retain ${jobId}`);
    assert.equal(job.needs, "classify-changes", jobId);
    assert.equal(job.if, `needs.classify-changes.outputs.${outputName} == 'true'`, jobId);
  }
});

test("inventory database suites receive the migrated CI database through Turbo", () => {
  const job = workflow.jobs["verify-api-tests"];
  assert.equal(job.env.INVENTORY_TEST_DATABASE_URL, job.env.DATABASE_URL);
  const turbo = JSON.parse(readFileSync("turbo.json", "utf8"));
  assert.ok(turbo.tasks.test.env.includes("INVENTORY_TEST_DATABASE_URL"));
  const apiTurbo = JSON.parse(readFileSync("apps/api/turbo.json", "utf8"));
  assert.ok(apiTurbo.tasks.test.env.includes("INVENTORY_TEST_DATABASE_URL"));
});

test("Signer Windows verification includes the stable release contract", () => {
  const job = workflow.jobs["signer-windows-build"];
  assert.ok(job.steps.some((step) => step.run === "pnpm test:signer-release:contract"));
});

test("National Catalog storage checks run after private SeaweedFS is healthy", () => {
  const job = workflow.jobs["tenant-team-infrastructure"];
  const storageStart = stepByName(job, "Start PostgreSQL, Mailpit, and SeaweedFS");
  const storage = job.steps.find((step) =>
    step.run?.includes("test/national-catalog-image.test.ts"),
  );
  assert.ok(storage, "the infrastructure job must execute the real catalog image round trip");
  assert.equal(job.env.LOCAL_INFRA_SMOKE, "1");
  assert.equal(job.env.S3_ENDPOINT, "http://127.0.0.1:9000");
  assert.equal(storage.if, undefined, "storage coverage must not silently skip");
  assert.match(storageStart.run, /postgres mailpit seaweedfs/);
  assert.ok(job.steps.indexOf(storage) > job.steps.indexOf(storageStart));
  assert.ok(
    job.steps.indexOf(storage) >
      job.steps.indexOf(stepByName(job, "Build API workspace dependencies")),
  );
});

test("ci-required always evaluates the classifier and every heavy job", () => {
  const gate = workflow.jobs["ci-required"];
  assert.ok(gate, "workflow must define ci-required");
  assert.equal(gate.if, "always()");
  assert.deepEqual(gate.needs, ["classify-changes", ...heavyJobs.map(([jobId]) => jobId)]);
  assert.equal(gate.outputs.result, "${{ steps.result.outputs.result }}");

  const resultStep = stepByName(gate, "Verify required CI results");
  assert.ok(resultStep, "ci-required must execute the result evaluator");
  assert.equal(resultStep.id, "result");
  assert.equal(resultStep.env.CI_NEEDS_JSON, "${{ toJSON(needs) }}");
  assert.equal(resultStep.run, "node tools/ci/required-results.mjs --needs-env CI_NEEDS_JSON");
});

test("National Catalog fixtures use existing Chromium job and preserve portable failure evidence", () => {
  const job = workflow.jobs["production-bundle"];
  const browser = stepByName(job, "Verify National Catalog cabinet fixtures");
  assert.equal(
    browser.run,
    "pnpm --dir tools/production-browser --ignore-workspace test:national-catalog",
  );
  assert.ok(
    job.steps.indexOf(browser) >
      job.steps.indexOf(stepByName(job, "Verify the inventory admin gallery contract")),
  );
  const artifact = stepByName(job, "Preserve National Catalog browser failure evidence");
  assert.equal(artifact.if, "failure()");
  assert.match(artifact.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/);
  assert.equal(artifact.with.path, "tools/production-browser/test-results/national-catalog");
  const config = readFileSync(
    "tools/production-browser/national-catalog.playwright.config.ts",
    "utf8",
  );
  assert.match(config, /outputDir: "\.\/test-results\/national-catalog"/);
  assert.match(config, /trace: "retain-on-failure"/);
  assert.match(config, /screenshot: "only-on-failure"/);
  assert.match(config, /retries: 0/);
  assert.match(config, /43183 --strictPort/);
});

test("product-labels browser contract runs in the Chromium job after both app builds and keeps failure evidence", () => {
  const job = workflow.jobs["production-bundle"];
  const browser = stepByName(job, "Verify the product-labels browser contract");
  assert.equal(
    browser.run,
    "pnpm --dir tools/production-browser --ignore-workspace test:product-labels",
  );
  // It serves both the admin and the Station harness, so both dependency builds come first.
  for (const build of [
    "Verify the station inventory gallery contract",
    "Verify the inventory admin gallery contract",
  ]) {
    assert.ok(job.steps.indexOf(browser) > job.steps.indexOf(stepByName(job, build)));
  }
  const artifact = stepByName(job, "Preserve product-labels browser failure evidence");
  assert.equal(artifact.if, "failure()");
  assert.match(artifact.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/);
  assert.equal(artifact.with.path, "tools/production-browser/test-results/product-labels");
  const config = readFileSync(
    "tools/production-browser/product-labels.playwright.config.ts",
    "utf8",
  );
  assert.match(config, /outputDir: "\.\/test-results\/product-labels"/);
  assert.match(config, /trace: "retain-on-failure"/);
  assert.match(config, /screenshot: "only-on-failure"/);
  assert.match(config, /retries: 0/);
  // Distinct from the National Catalog harness (43183) that runs in the same job.
  assert.match(config, /"PRODUCT_LABELS_ADMIN_PORT", 43181/);
  assert.match(config, /"PRODUCT_LABELS_STATION_PORT", 43182/);
  assert.equal(config.match(/--strictPort/g)?.length, 2);
});

test("production-bundle reserves every browser harness port Linux could hand out as a source port", () => {
  const job = workflow.jobs["production-bundle"];
  const reserve = stepByName(job, "Reserve browser harness ports");
  assert.ok(reserve, "production-bundle must reserve its browser harness ports");
  const range = /^sudo sysctl -w net\.ipv4\.ip_local_reserved_ports=(\d+)-(\d+)$/.exec(
    reserve.run.trim(),
  );
  assert.ok(range, "the reservation must be one sysctl range");
  const [low, high] = [Number(range[1]), Number(range[2])];
  // Before the first suite opens a loopback connection that could take one of them.
  const firstBrowser = job.steps.findIndex((step) =>
    /tools\/production-browser|:browser\b/.test(step.run ?? ""),
  );
  assert.ok(firstBrowser >= 0 && job.steps.indexOf(reserve) < firstBrowser);

  const ports = new Set();
  for (const name of readdirSync("tools/production-browser")) {
    if (!name.endsWith(".playwright.config.ts")) continue;
    const config = readFileSync(join("tools/production-browser", name), "utf8");
    for (const match of config.matchAll(
      /(?:--port[ =]|port = |_PORT", |(?:127\.0\.0\.1|localhost):)(\d[\d_]*)/g,
    )) {
      ports.add(Number(match[1].replaceAll("_", "")));
    }
  }
  // The scan must still see the harnesses, or the check below proves nothing.
  for (const known of [43179, 43182, 43188, 61593]) assert.ok(ports.has(known), `port ${known}`);
  // ubuntu-latest hands out source ports from 32768-60999.
  const exposed = [...ports]
    .filter((port) => port >= 32768 && port <= 60999 && (port < low || port > high))
    .sort((a, b) => a - b);
  assert.deepEqual(exposed, []);
});

test("Android gate verifies original signed and budget fixture byte parity before Gradle", () => {
  const steps = workflow.jobs["handheld-android"].steps;
  const parity = steps.findIndex((step) => step.name === "Verify shared offline grant fixtures");
  const gradle = steps.findIndex((step) => step.name === "Unit tests, lint, debug build");
  assert.ok(parity >= 0 && parity < gradle);
  assert.match(steps[parity].run, /cmp .*offline-grants-v1\.json .*offline-grants-v1\.json/);
  assert.match(
    steps[parity].run,
    /cmp .*offline-grant-budgets-v1\.json .*offline-grant-budgets-v1\.json/,
  );
});
