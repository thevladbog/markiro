import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

const root = new URL("../../../", import.meta.url);
const source = () =>
  readFile(new URL(".github/workflows/station-stable-release.yml", root), "utf8");

test("station stable publication promotes an explicit accepted beta channel-last", async () => {
  const text = await source();
  const workflow = load(text);

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "mode",
    "source_beta_tag",
    "acceptance_confirmed",
    "highlights",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
    "publish",
    "promote-existing",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.acceptance_confirmed.default, false);
  assert.equal(workflow.concurrency.group, "station-stable-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.release.environment, "station-stable");
  assert.equal(workflow.jobs.release["runs-on"], "windows-latest");
  assert.deepEqual(workflow.jobs.release.permissions, { actions: "read", contents: "write" });
  assert.equal(workflow.jobs.release.env.VITE_STATION_API_URL, "https://admin.markiro.app");
  assert.equal(workflow.jobs.release.env.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(workflow.jobs.release.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined);

  const steps = workflow.jobs.release.steps;
  const acceptedBeta = steps.find((step) => step.name === "Resolve and verify accepted beta");
  const build = steps.find((step) => step.name === "Build signed stable Windows artifacts");
  const immutable = steps.find((step) => step.name === "Publish immutable stable release");
  const existing = steps.find(
    (step) => step.name === "Prepare existing stable release for channel recovery",
  );
  const channel = steps.find((step) => step.name === "Promote stable channel");
  const cleanup = steps.find((step) => step.name === "Cleanup owned stable release material");
  assert.ok(acceptedBeta);
  assert.ok(build);
  assert.ok(immutable);
  assert.ok(existing);
  assert.ok(channel);
  assert.ok(cleanup);
  assert.equal(cleanup.if, "always()");
  assert.ok(steps.indexOf(acceptedBeta) < steps.indexOf(build));
  assert.ok(steps.indexOf(build) < steps.indexOf(immutable));
  assert.ok(steps.indexOf(immutable) < steps.indexOf(channel));

  assert.match(text, /refs\/heads\/main/);
  assert.match(text, /test "\$acceptance_confirmed" = "true"/);
  assert.match(text, /source_beta_tag.*station-v.*-beta/s);
  assert.match(text, /gh release view "\$source_beta_tag"/);
  assert.match(text, /gh release download "\$source_beta_tag"/);
  assert.match(text, /artifacts\.mjs validate beta/);
  assert.match(text, /promotion\.mjs validate-beta/);
  assert.match(text, /git merge-base --is-ancestor "\$base_sha" origin\/main/);
  assert.match(text, /--commit "\$base_sha"/);
  assert.match(text, /tauri\.stable\.conf\.json/);
  assert.match(text, /tauri build[\s\S]*--config src-tauri\/tauri\.stable\.conf\.json/);
  assert.match(text, /normalized_key="\$\(.*normalize-signing-key\.mjs/s);
  assert.match(text, /printf '%s' "\$normalized_key" > "\$normalized_key_file"/);
  assert.match(text, /artifacts\.mjs stage-stable/);
  assert.match(text, /artifacts\.mjs validate stable/);
  assert.match(text, /changelog\.mjs generate/);
  assert.match(text, /gh release create "\$tag"[^\n]*--draft[^\n]*--target "\$release_sha"/);
  assert.match(text, /gh release edit "\$tag"[^\n]*--draft=false/);
  assert.match(text, /gh release create station-stable-channel[^\n]*--prerelease/);
  assert.match(text, /station-channel-backup/);
  assert.match(channel.run, /cmp "\$verify_dir\/latest\.json"/);
  assert.match(
    channel.run,
    /channel_manifest="\$RUNNER_TEMP\/station-stable-channel\/latest\.json"/,
  );
  assert.match(text, /station-stable-channel.*latest\.json/s);
  assert.match(existing.run, /e\.betaEvidenceSha256!==process\.env\.BETA_EVIDENCE_SHA256/);
  assert.match(channel.run, /--json tagName,isDraft,isPrerelease,assets/);
  assert.doesNotMatch(channel.run, /--pattern latest\.json --dir "\$backup_dir" \|\| true/);
  assert.match(text, /candidate_ref="station-stable-release-candidate-\$\{GITHUB_RUN_ID\}"/);
  assert.match(text, /persist-credentials:\s*false/);
  assert.doesNotMatch(text, /pull_request_target|self-hosted|id-token|continue-on-error/i);
  assert.doesNotMatch(text, /git[^\n]*(?:--force|-f\b)|gh release upload "\$tag"[^\n]*--clobber/i);
});
