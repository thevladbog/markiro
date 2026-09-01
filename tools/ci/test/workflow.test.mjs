import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("Signer Windows verification includes the stable release contract", () => {
  const job = workflow.jobs["signer-windows-build"];
  assert.ok(job.steps.some((step) => step.run === "pnpm test:signer-release:contract"));
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
