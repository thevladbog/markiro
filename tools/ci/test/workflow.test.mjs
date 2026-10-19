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
  ["standalone-rust", "standalone_rust"],
  ["standalone-windows-build", "standalone_windows_build"],
  ["standalone-app-tests", "standalone_app_tests"],
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

test("production bundle retains both contract suites owning the deployment workflow", () => {
  const job = workflow.jobs["production-bundle"];
  for (const command of ["pnpm test:production-bundle:contract", "pnpm test:yandex-runtime"])
    assert.ok(
      job.steps.some((step) => step.run === command),
      `missing deployment gate: ${command}`,
    );
});

test("inventory database suites receive the migrated CI database through Turbo", () => {
  const job = workflow.jobs["verify-api-tests"];
  assert.equal(job.env.INVENTORY_TEST_DATABASE_URL, job.env.DATABASE_URL);
  const turbo = JSON.parse(readFileSync("turbo.json", "utf8"));
  assert.ok(turbo.tasks.test.env.includes("INVENTORY_TEST_DATABASE_URL"));
  const apiTurbo = JSON.parse(readFileSync("apps/api/turbo.json", "utf8"));
  assert.ok(apiTurbo.tasks.test.env.includes("INVENTORY_TEST_DATABASE_URL"));
});

test("isolated support chat tests retain explicit scratch database guards through Turbo", () => {
  for (const file of ["turbo.json", "apps/api/turbo.json"]) {
    const turbo = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(turbo.tasks.test.env.includes("SUPPORT_CHAT_ISOLATED_DB"), file);
    assert.ok(turbo.tasks.test.env.includes("SUPPORT_CHAT_TEST_MAINTENANCE_URL"), file);
    assert.ok(!turbo.tasks.test.env.includes("SUPPORT_CHAT_BROWSER_CONTROL_DIR"), file);
  }
});

test("the standalone export runs in the Node job after the domain build and its SQL after the migrations", () => {
  const command = "pnpm test:standalone-export";
  const staticSteps = workflow.jobs["verify-static"].steps;
  const staticRun = staticSteps.findIndex((step) => step.run === command);
  assert.ok(staticRun >= 0, "verify-static must run the export tool's tests");
  assert.equal(staticSteps[staticRun].env, undefined, "the pure run must not see a database");
  const build = staticSteps.findIndex(
    (step) => step.run === "pnpm turbo run build --filter=@markiro/domain",
  );
  assert.ok(build >= 0 && build < staticRun, "packages/domain must be built before the tests");

  const apiSteps = workflow.jobs["verify-api-tests"].steps;
  const migrate = apiSteps.findIndex((step) => step.run === "pnpm --filter @markiro/db db:migrate");
  const sqlRun = apiSteps.findIndex((step) => step.run === command);
  assert.ok(migrate >= 0 && sqlRun > migrate, "the SQL test must run after the cloud migrations");
  assert.equal(
    apiSteps[sqlRun].env.STANDALONE_EXPORT_TEST_DATABASE_URL,
    workflow.jobs["verify-api-tests"].env.DATABASE_URL,
  );
});

test("the standalone app's Vitest suite runs in its own job and in no other app slice", () => {
  const appSlice = workflow.jobs["verify-app-tests"].steps.filter((step) =>
    step.run?.startsWith("pnpm turbo test"),
  );
  assert.deepEqual(
    appSlice.map((step) => step.run),
    [
      "pnpm turbo test --filter=!@markiro/db --filter=!@markiro/api --filter=!@markiro/standalone --concurrency=1 --force",
    ],
  );

  const job = workflow.jobs["standalone-app-tests"];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job.env, undefined, "the suite is database-free, like verify-app-tests");
  assert.ok(Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0);
  assert.deepEqual(
    job.steps.filter((step) => step.run?.startsWith("pnpm turbo")).map((step) => step.run),
    ["pnpm turbo test --filter=@markiro/standalone --concurrency=1 --force"],
  );
});

test("both standalone cargo test steps report every failing test binary in one run", () => {
  for (const name of ["standalone-rust", "standalone-windows-build"]) {
    const commands = workflow.jobs[name].steps
      .flatMap((step) => (step.run ?? "").split("\n"))
      .map((line) => line.trim())
      .filter((line) => /^cargo test\b/.test(line));
    assert.equal(commands.length, 1, `${name} runs cargo test once`);
    assert.match(
      commands[0],
      /--manifest-path apps\/standalone\/Cargo\.toml --workspace --no-fail-fast$/,
      name,
    );
  }
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

test("platform preparation builds its own edge and runs only after legacy cleanup", () => {
  const job = workflow.jobs["production-bundle"];
  const contracts = stepByName(job, "Verify portable platform preparation contracts");
  const build = stepByName(job, "Build local platform-only edge preparation image");
  const stack = stepByName(job, "Verify isolated platform-only preparation stack");
  const cleanup = stepByName(job, "Remove production-bundle containers and volumes");
  const roles = stepByName(job, "Verify isolated PostgreSQL roles and TLS");
  assert.match(roles.run, /pnpm --filter @markiro\/db build/);
  assert.match(roles.run, /node deploy\/platform\/postgres\/roles-ci\.mjs --local-ci/);
  assert.ok(job.steps.indexOf(roles) < job.steps.indexOf(stack));
  assert.equal(
    contracts.run,
    "env -u COMPOSE_PROJECT_NAME node --test deploy/platform/test/*.test.mjs",
  );
  assert.match(build.run, /deploy\/platform\/edge\.Dockerfile/u);
  assert.match(build.run, /markiro-platform-edge/u);
  assert.doesNotMatch(build.run, /--push|docker push/u);
  assert.equal(stack.run, "node deploy/platform/ci-stack.mjs --local-ci");
  assert.equal(stack.env.MARKIRO_SOURCE_SHA, "${{ github.sha }}");
  assert.ok(job.steps.indexOf(stack) > job.steps.indexOf(cleanup));
  assert.ok(job.steps.indexOf(build) > job.steps.indexOf(contracts));
  assert.equal(stepByName(job, "Preserve platform preparation evidence").if, "always()");
});

test("production-bundle owns the real fenced backup and isolated restore gate", () => {
  const job = workflow.jobs["production-bundle"];
  const backup = stepByName(job, "Verify isolated PostgreSQL backup and restore");
  const roles = stepByName(job, "Verify isolated PostgreSQL roles and TLS");
  const stack = stepByName(job, "Verify isolated platform-only preparation stack");
  assert.equal(
    backup.run,
    'node deploy/platform/backup/backup-ci.mjs --local-ci --export-image "$RUNNER_TEMP/platform-recovery-image"',
  );
  assert.ok(job.steps.indexOf(backup) > job.steps.indexOf(roles));
  assert.ok(job.steps.indexOf(backup) < job.steps.indexOf(stack));
});

test("platform deployment is protected main-only and supplies immutable independent executor/product identities", () => {
  const raw = readFileSync(".github/workflows/deploy-platform.yml", "utf8");
  const flow = load(raw);
  assert.deepEqual(Object.keys(flow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(flow.on.workflow_dispatch.inputs).sort(), [
    "artifact_id",
    "executor_ci_run_attempt",
    "executor_ci_run_id",
    "operation_id",
    "publisher_run_attempt",
    "publisher_run_id",
    "source_sha",
  ]);
  const job = flow.jobs.deploy;
  assert.equal(job.environment, "production-deploy");
  assert.equal(
    job.if,
    "${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' }}",
  );
  assert.equal(flow.concurrency["cancel-in-progress"], false);
  assert.equal(flow.concurrency.group, "timeweb-platform-production");
  assert.deepEqual(job.permissions, { contents: "read", actions: "read", packages: "read" });
  assert.ok(job["timeout-minutes"] >= 55);
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const step = stepByName(job, "Deliver pinned prepared platform operation");
  assert.equal(step.env.EXECUTOR_SHA, "${{ github.sha }}");
  assert.equal(step.env.EXECUTOR_CI_RUN_ID, "${{ inputs.executor_ci_run_id }}");
  assert.equal(step.env.EXECUTOR_CI_RUN_ATTEMPT, "${{ inputs.executor_ci_run_attempt }}");
  assert.equal(step.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(step.env.GITHUB_ACTOR, "${{ github.actor }}");
  assert.equal(
    step.env.TIMEWEB_PLATFORM_SSH_PRIVATE_KEY,
    "${{ secrets.TIMEWEB_PLATFORM_SSH_PRIVATE_KEY }}",
  );
  assert.equal(step.env.TIMEWEB_PLATFORM_KNOWN_HOSTS, "${{ vars.TIMEWEB_PLATFORM_KNOWN_HOSTS }}");
  assert.match(step.run, /printf '%s\\0'/u);
  assert.match(step.run, /\/usr\/bin\/env -i PATH=/u);
  assert.match(step.run, /transport\.mjs run/u);
  assert.doesNotMatch(
    raw,
    /upload-artifact|ssh-keyscan|YC_APP|MARKIRO_DEPLOY_HOST|\bPAT\b|secrets\.GITHUB_TOKEN|docker compose|node -e/u,
  );
  for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/u);
});

test("platform delivery starts Node before any ambient loader can run and keeps input out of argv", () => {
  const flow = load(readFileSync(".github/workflows/deploy-platform.yml", "utf8"));
  const step = stepByName(flow.jobs.deploy, "Deliver pinned prepared platform operation");
  const env = Object.fromEntries(
    Object.keys(step.env).map((key) => [key, "fixture-invalid-input"]),
  );
  env.PATH = process.env.PATH;
  env.NODE_OPTIONS = `--import=${process.cwd()}/deploy/platform/test/fixtures/transport-poison.mjs`;
  env.NODE_PATH = "/untrusted";
  const result = spawnSync("/bin/bash", ["-c", step.run], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Platform transport failed; preserve host operation and reconcile before retry.\n",
  );
  assert.doesNotMatch(result.stderr, /UNTRUSTED_NODE_LOADER|fixture-invalid-input/u);
});

test("production-bundle preserves only verified recovery image and manifest after successful backup cleanup", () => {
  const job = workflow.jobs["production-bundle"];
  const backup = stepByName(job, "Verify isolated PostgreSQL backup and restore");
  const upload = stepByName(job, "Preserve verified recovery worker image");
  assert.equal(
    backup.run,
    'node deploy/platform/backup/backup-ci.mjs --local-ci --export-image "$RUNNER_TEMP/platform-recovery-image"',
  );
  assert.equal(job.steps.indexOf(upload), job.steps.indexOf(backup) + 1);
  assert.equal(upload.if, "success()");
  assert.match(upload.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/u);
  assert.equal(
    upload.with.name,
    "platform-recovery-worker-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.equal(
    upload.with.path,
    "${{ runner.temp }}/platform-recovery-image/recovery-image.tar\n${{ runner.temp }}/platform-recovery-image/recovery-image.json\n",
  );
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 7);
  assert.equal(upload.with.overwrite, undefined);
});

test("production-bundle exports ICU worker separately with exact pinned two-file upload", () => {
  const job = workflow.jobs["production-bundle"];
  const backup = stepByName(job, "Verify isolated ICU PostgreSQL backup and restore");
  const upload = stepByName(job, "Preserve verified ICU recovery worker image");
  assert.equal(
    backup.run,
    'node deploy/platform/backup/backup-ci.mjs --local-ci --icu --export-image "$RUNNER_TEMP/platform-recovery-image-icu"',
  );
  assert.equal(job.steps.indexOf(upload), job.steps.indexOf(backup) + 1);
  assert.equal(upload.if, "success()");
  assert.equal(upload.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.equal(
    upload.with.name,
    "platform-recovery-worker-icu-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.equal(
    upload.with.path,
    "${{ runner.temp }}/platform-recovery-image-icu/recovery-image.tar\n${{ runner.temp }}/platform-recovery-image-icu/recovery-image.json\n",
  );
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 7);
  assert.equal(upload.with.overwrite, undefined);
});
