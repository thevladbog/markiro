import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

const root = new URL("../../../", import.meta.url);
const source = () => readFile(new URL(".github/workflows/station-beta-release.yml", root), "utf8");

test("station beta publication is protected, serialized, main-only and channel-last", async () => {
  const text = await source();
  const workflow = load(text);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["mode", "bump"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
    "publish",
    "promote-existing",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.bump.options, [
    "next-beta",
    "next-patch-beta",
    "next-minor-beta",
  ]);
  assert.equal(workflow.concurrency.group, "station-beta-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.release["runs-on"], "windows-latest");
  assert.equal(workflow.jobs.release.environment, "station-beta");
  assert.deepEqual(workflow.jobs.release.permissions, { actions: "read", contents: "write" });
  assert.match(text, /refs\/heads\/main/);
  assert.match(text, /VITE_STATION_API_URL:\s*https:\/\/admin\.markiro\.app/);
  assert.match(text, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(text, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  assert.match(text, /Waiting for CI for \$GITHUB_SHA/);
  assert.match(text, /for attempt in \{1\.\.90\}/);
  assert.equal(workflow.jobs.release.env.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(workflow.jobs.release.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined);
  const signingStep = workflow.jobs.release.steps.find(
    (step) => step.name === "Build signed Windows NSIS updater artifacts",
  );
  assert.equal(
    signingStep.env.TAURI_SIGNING_PRIVATE_KEY,
    "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
  );
  assert.equal(
    signingStep.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
    "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
  );
  assert.match(text, /Decode Tauri updater signing key/);
  assert.match(text, /untrusted comment: rsign encrypted secret key/);
  assert.match(text, /persist-credentials:\s*false/);
  assert.match(text, /pnpm\/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1/);
  assert.match(text, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.match(text, /dtolnay\/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4/);
  assert.match(text, /gh release create station-beta-channel[^\n]*--prerelease/);
  assert.ok(
    text.indexOf("Publish immutable version release") < text.indexOf("Promote beta channel"),
  );
  assert.doesNotMatch(text, /force|:latest\b|pull_request_target|self-hosted|id-token|curl .+\|/i);
  assert.doesNotMatch(text, /continue-on-error/i);
});
