import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { UPGRADE_BUNDLE_FILES } from "../../../deploy/platform/host/upgrade-command.mjs";
import { classifyChangedFiles } from "../affected.mjs";
test("upgrade phases are independently protected, serialized and stdin-only", () => {
  const raw = readFileSync(".github/workflows/upgrade-platform.yml", "utf8"),
    w = load(raw);
  assert.deepEqual(Object.keys(w.on), ["workflow_dispatch"]);
  assert.deepEqual(w.on.workflow_dispatch.inputs.phase.options, [
    "prepare",
    "activate",
    "return-old",
    "post-migration-prepare",
    "post-migration-activate",
  ]);
  assert.deepEqual(w.concurrency, {
    group: "timeweb-platform-production",
    "cancel-in-progress": false,
  });
  const job = w.jobs.deploy;
  assert.equal(job.environment, "production-deploy");
  assert.ok(job.if.includes("refs/heads/main") && job.if.includes("github.run_attempt == 1"));
  assert.deepEqual(job.permissions, { contents: "read", actions: "read", packages: "read" });
  assert.equal(job.steps[0].with["persist-credentials"], false);
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  for (const step of job.steps.filter((s) => s.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/u);
  const run = job.steps.at(-1).run;
  assert.ok(run.includes("printf '%s\\0'"));
  assert.ok(run.includes('/usr/bin/env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin"'));
  assert.ok(run.includes('"$node_bin" deploy/platform/upgrade-transport.mjs run'));
  assert.ok(!run.includes("${{"));
});
test("upgrade implementation and workflow select required platform contracts and production bundle", () => {
  for (const file of [
    "deploy/platform/upgrade-transport.mjs",
    "deploy/platform/host/upgrade-command-runtime.mjs",
    ".github/workflows/upgrade-platform.yml",
    ".github/workflows/ci.yml",
    "deploy/platform/forward-ci.mjs",
    "deploy/platform/forward-ci-scenario.mjs",
    ...UPGRADE_BUNDLE_FILES.filter((path) => path.includes("/forward-")),
  ]) {
    const { jobs } = classifyChangedFiles([file]);
    assert.equal(jobs.production_bundle, true);
    assert.equal(jobs.platform_contracts, true);
  }
});
test("required production gate rehearses exact old return and exports only safe result", () => {
  const w = load(readFileSync(".github/workflows/ci.yml", "utf8"));
  const steps = w.jobs["production-bundle"].steps;
  assert.equal(steps[0].with["fetch-depth"], 0);
  const recovery = steps.findIndex((s) => s.run?.includes("deploy/platform/recovery-ci.mjs"));
  const rehearsal = steps.findIndex((s) => s.run?.includes("rehearseUpgrade"));
  const stack = steps.findIndex((s) => s.run?.includes("deploy/platform/ci-stack.mjs"));
  assert.ok(recovery >= 0 && rehearsal > recovery && stack > rehearsal);
  assert.match(
    steps[rehearsal].run,
    /docker pull --platform linux\/amd64 docker:28-dind@sha256:[a-f0-9]{64}/u,
  );
  assert.ok(steps[rehearsal].run.includes('rehearseUpgrade(["--local-ci"], {'));
  assert.ok(steps[rehearsal].run.includes('flag: "wx"'));
  const evidence = steps.find((s) => s.with?.name === "platform-upgrade-return-evidence");
  assert.ok(evidence);
  assert.equal(evidence.if, "always()");
  assert.ok(steps[rehearsal].run.includes("writeResult:"));
  assert.match(evidence.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/u);
  assert.equal(evidence.with.path, "${{ runner.temp }}/platform-upgrade-return.json");
  assert.equal(evidence.with["if-no-files-found"], "error");
  assert.equal(evidence.with.overwrite, false);
  assert.equal(
    classifyChangedFiles(["deploy/platform/upgrade-ci.mjs"]).jobs.production_bundle,
    true,
  );
});

test("required production gate runs actual forward recovery serially and exports only safe create-only evidence", () => {
  const w = load(readFileSync(".github/workflows/ci.yml", "utf8")),
    steps = w.jobs["production-bundle"].steps;
  const old = steps.findIndex((s) => s.run?.includes("rehearseUpgrade"));
  const forward = steps.findIndex((s) => s.run?.includes("rehearseForwardRecovery"));
  const stack = steps.findIndex((s) => s.run?.includes("deploy/platform/ci-stack.mjs"));
  assert.ok(old >= 0 && forward > old && stack > forward);
  assert.ok(steps[forward].run.includes('flag: "wx"'));
  assert.equal(steps[forward].if, undefined);
  const upload = steps.find((s) => s.with?.name === "platform-forward-recovery-evidence");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, "${{ runner.temp }}/platform-forward-recovery.json");
  assert.equal(upload.with.overwrite, false);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.match(upload.uses, /@[a-f0-9]{40}$/u);
});
