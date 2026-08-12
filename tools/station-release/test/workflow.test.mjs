import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";
import { normalizeTauriSigningKey } from "../normalize-signing-key.mjs";

const root = new URL("../../../", import.meta.url);
const source = () => readFile(new URL(".github/workflows/station-beta-release.yml", root), "utf8");
const packageSource = () => readFile(new URL("package.json", root), "utf8");

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
  assert.match(text, /--commit \"\$GITHUB_SHA\"/);
  assert.match(text, /CI for \$GITHUB_SHA completed with conclusion/);
  assert.equal(workflow.jobs.release.env.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(workflow.jobs.release.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined);
  const signingStep = workflow.jobs.release.steps.find(
    (step) => step.name === "Build signed Windows NSIS updater artifacts",
  );
  const corsStep = workflow.jobs.release.steps.find(
    (step) => step.name === "Verify production station pairing CORS",
  );
  assert.equal(corsStep.if, "inputs.mode == 'publish' || inputs.mode == 'promote-existing'");
  assert.equal(corsStep.run, "pnpm verify:station-production-cors");
  assert.ok(
    workflow.jobs.release.steps.indexOf(corsStep) <
      workflow.jobs.release.steps.indexOf(signingStep),
  );
  const promoteStep = workflow.jobs.release.steps.find(
    (step) => step.name === "Promote beta channel",
  );
  assert.ok(
    workflow.jobs.release.steps.indexOf(corsStep) <
      workflow.jobs.release.steps.indexOf(promoteStep),
  );
  assert.equal(workflow.jobs.release.env.VITE_STATION_API_URL, "https://admin.markiro.app");
  assert.equal(
    signingStep.env.TAURI_SIGNING_PRIVATE_KEY,
    "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
  );
  assert.equal(
    signingStep.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
    "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
  );
  assert.match(text, /Decode Tauri updater signing key/);
  assert.match(text, /normalized_key=\"\$\(.*normalize-signing-key\.mjs\)/s);
  assert.match(text, /normalized_key=.*\r?\n\s*normalized_key_file=/);
  assert.match(text, /printf '%s' \"\$TAURI_SIGNING_PRIVATE_KEY\" > \"\$normalized_key_file\"/);
  assert.match(text, /export TAURI_SIGNING_PRIVATE_KEY=\"\$normalized_key_file\"/);
  assert.match(text, /bundle=\"\$installer\"/);
  assert.match(text, /signature=\"\$bundle\.sig\"/);
  assert.match(
    text,
    /auth_header=\"AUTHORIZATION: basic \$\(printf 'x-access-token:%s' \"\$GH_TOKEN\" \| base64 -w0\)\"/,
  );
  assert.match(text, /git -c \"http\.extraheader=\$auth_header\" push/);
  assert.match(text, /trap 'rm -f \"\$normalized_key_file\"' EXIT/);
  assert.ok(text.indexOf("normalize-signing-key.mjs") < text.indexOf("tauri build"));
  assert.match(text, /persist-credentials:\s*false/);
  assert.match(text, /pnpm\/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1/);
  assert.match(text, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.match(text, /dtolnay\/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4/);
  assert.match(text, /gh release create station-beta-channel[^\n]*--prerelease/);
  assert.match(
    text,
    /cp \"\$RUNNER_TEMP\/station-staged\/latest\.json\" \"\$RUNNER_TEMP\/latest\.json\"/,
  );
  assert.match(
    text,
    /gh release upload station-beta-channel[^\n]*\"\$RUNNER_TEMP\/latest\.json\" --clobber/,
  );
  assert.match(text, /gh release download station-beta-channel[^\n]*\|\| true/);
  assert.ok(
    text.indexOf("Publish immutable version release") < text.indexOf("Promote beta channel"),
  );
  assert.doesNotMatch(text, /force|:latest\b|pull_request_target|self-hosted|id-token|curl .+\|/i);
  assert.doesNotMatch(text, /continue-on-error/i);
});

test("normalizes raw and base64-wrapped Tauri keys and rejects invalid input", async () => {
  const raw = "untrusted comment: rsign encrypted secret key\nRWZha2U=\n";
  assert.equal(normalizeTauriSigningKey(raw), raw);
  const wrapped = Buffer.from(raw, "utf8").toString("base64");
  assert.equal(normalizeTauriSigningKey(wrapped), raw);
  assert.throws(() => normalizeTauriSigningKey("not-a-signing-key"), /not a Tauri rsign/);
});

test("the workflow CORS gate pins the production API and Windows webview origin", async () => {
  const packageJson = JSON.parse(await packageSource());
  assert.equal(
    packageJson.scripts["verify:station-production-cors"],
    "node tools/station-release/verify-api-cors.mjs https://admin.markiro.app",
  );

  const { verifyStationCors } = await import("../verify-api-cors.mjs");
  const expectedPreflights = [
    ["/station/pair", "POST", "content-type,x-station-capabilities"],
    ["/station/operators", "GET", "content-type,x-api-key,x-station-capabilities"],
    ["/shifts", "GET", "content-type,x-api-key,x-station-capabilities"],
    ["/shifts", "POST", "content-type,x-api-key,x-station-capabilities"],
    ["/shifts/cors-probe/open", "POST", "content-type,x-api-key,x-station-capabilities"],
    ["/shifts/cors-probe/bundle", "GET", "content-type,x-api-key,x-station-capabilities"],
    ["/products", "GET", "content-type,x-api-key,x-station-capabilities"],
    ["/products/gtin-check", "POST", "content-type,x-api-key,x-station-capabilities"],
  ];
  const calls = [];
  await verifyStationCors({
    apiUrl: "https://admin.markiro.app",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.headers.Origin, "http://tauri.localhost");
      return new Response(undefined, {
        status: 204,
        headers: { "Access-Control-Allow-Origin": "http://tauri.localhost" },
      });
    },
  });
  assert.deepEqual(
    calls.map(({ url, init }) => [
      new URL(url).pathname,
      init.headers["Access-Control-Request-Method"],
      init.headers["Access-Control-Request-Headers"],
    ]),
    expectedPreflights,
  );
});
