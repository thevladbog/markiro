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

test("classifier uses the exact pull-request diff and exposes every policy output", () => {
  const classifier = workflow.jobs["classify-changes"];
  assert.ok(classifier, "workflow must define classify-changes");

  const checkout = classifier.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkout, "classifier must check out the repository");
  assert.equal(checkout.with["fetch-depth"], 0);

  const classifyStep = classifier.steps.find((step) => step.id === "affected");
  assert.ok(classifyStep, "classifier must expose the affected step");
  assert.equal(classifyStep.env.EVENT_NAME, "${{ github.event_name }}");
  assert.equal(classifyStep.env.BASE_SHA, "${{ github.event.pull_request.base.sha }}");
  assert.equal(classifyStep.env.HEAD_SHA, "${{ github.event.pull_request.head.sha }}");
  assert.match(classifyStep.run, /git diff --name-only --no-renames -z "\$BASE_SHA" "\$HEAD_SHA"/);
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
      BASE_SHA: "base-sha",
      EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: outputPath,
      HEAD_SHA: "head-sha",
      PATH: `${binaryDirectory}:${process.env.PATH}`,
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

  const resultStep = stepByName(gate, "Verify required CI results");
  assert.ok(resultStep, "ci-required must execute the result evaluator");
  assert.equal(resultStep.env.CI_NEEDS_JSON, "${{ toJSON(needs) }}");
  assert.equal(resultStep.run, "node tools/ci/required-results.mjs --needs-env CI_NEEDS_JSON");
});
