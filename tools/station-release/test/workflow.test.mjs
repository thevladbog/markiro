import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";
import { normalizeTauriSigningKey } from "../normalize-signing-key.mjs";

const root = new URL("../../../", import.meta.url);
const source = () => readFile(new URL(".github/workflows/station-beta-release.yml", root), "utf8");
const packageSource = () => readFile(new URL("package.json", root), "utf8");

test("station beta build and dual-origin publication use separate exact protected environments", async () => {
  const text = await source();
  const workflow = load(text);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "mode",
    "bump",
    "seed_infrastructure_evidence",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
    "publish",
    "promote-existing",
    "seed-baseline",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.bump.options, [
    "next-beta",
    "next-patch-beta",
    "next-minor-beta",
    "next-major-beta",
  ]);
  assert.equal(workflow.concurrency.group, "station-beta-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(workflow.jobs), ["build", "release"]);
  assert.equal(workflow.jobs.build["runs-on"], "windows-latest");
  assert.equal(workflow.jobs.build.environment, "station-beta");
  assert.deepEqual(workflow.jobs.build.permissions, { actions: "read", contents: "read" });
  assert.equal(workflow.jobs.release["runs-on"], "windows-latest");
  assert.equal(workflow.jobs.release.environment, "station-release");
  assert.equal(workflow.jobs.release.needs, "build");
  assert.deepEqual(workflow.jobs.release.permissions, { actions: "read", contents: "write" });
  assert.match(text, /refs\/heads\/main/);
  assert.match(text, /VITE_STATION_API_URL:\s*https:\/\/admin\.markiro\.app/);
  assert.match(text, /Waiting for CI for \$GITHUB_SHA/);
  assert.match(text, /for attempt in \{1\.\.90\}/);
  assert.match(text, /--commit "\$GITHUB_SHA"/);
  assert.match(text, /CI for \$GITHUB_SHA completed with conclusion/);
  assert.equal(workflow.jobs.build.env.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(workflow.jobs.release.env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(workflow.jobs.release.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.build), /YANDEX_STATION_RELEASE/);

  const signingStep = workflow.jobs.build.steps.find(
    (step) => step.name === "Build signed Windows NSIS updater artifacts",
  );
  const verifyStep = workflow.jobs.build.steps.find(
    (step) => step.name === "Build and verify station",
  );
  assert.match(
    verifyStep.run,
    /pnpm --filter @markiro\/station exec vitest run --maxWorkers=2 --testTimeout=30000/,
  );
  const corsStep = workflow.jobs.build.steps.find(
    (step) => step.name === "Verify production station pairing CORS",
  );
  assert.equal(corsStep.if, undefined);
  assert.equal(corsStep.run, "pnpm verify:station-production-cors");
  assert.ok(
    workflow.jobs.build.steps.indexOf(corsStep) < workflow.jobs.build.steps.indexOf(signingStep),
  );
  assert.equal(workflow.jobs.build.env.VITE_STATION_API_URL, "https://admin.markiro.app");
  assert.equal(
    signingStep.env.TAURI_SIGNING_PRIVATE_KEY,
    "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
  );
  assert.equal(
    signingStep.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
    "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
  );
  assert.equal(signingStep.if, "inputs.mode == 'publish' || inputs.mode == 'seed-baseline'");
  assert.match(text, /Validate Tauri updater signing key/);
  assert.match(
    signingStep.run,
    /printf '%s' "\$TAURI_SIGNING_PRIVATE_KEY" \| node tools\/station-release\/normalize-signing-key\.mjs > \/dev\/null/,
  );
  assert.match(text, /signing_key_file="\$RUNNER_TEMP\/station-updater\.key"/);
  assert.match(text, /printf '%s' "\$TAURI_SIGNING_PRIVATE_KEY" > "\$signing_key_file"/);
  assert.match(text, /export TAURI_SIGNING_PRIVATE_KEY="\$signing_key_file"/);
  assert.doesNotMatch(signingStep.run, /normalized_key=/);
  assert.match(text, /bundle="\$installer"/);
  assert.match(text, /signature="\$bundle\.sig"/);
  assert.match(text, /trap 'rm -f "\$signing_key_file"' EXIT/);
  assert.ok(text.indexOf("normalize-signing-key.mjs") < text.indexOf("tauri build"));
  assert.match(text, /persist-credentials:\s*false/);
  assert.match(text, /pnpm\/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1/);
  assert.match(text, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.match(text, /dtolnay\/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4/);

  const credentialSteps = workflow.jobs.release.steps.filter((step) =>
    JSON.stringify(step.env ?? {}).includes("YANDEX_STATION_RELEASE_ACCESS_KEY_ID"),
  );
  assert.equal(credentialSteps.length, 2);
  for (const step of credentialSteps) {
    assert.equal(step.env.AWS_ACCESS_KEY_ID, "${{ secrets.YANDEX_STATION_RELEASE_ACCESS_KEY_ID }}");
    assert.equal(
      step.env.AWS_SECRET_ACCESS_KEY,
      "${{ secrets.YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY }}",
    );
    assert.equal(
      step.env.YANDEX_STATION_RELEASE_BUCKET,
      "${{ vars.YANDEX_STATION_RELEASE_BUCKET }}",
    );
    assert.equal(
      step.env.YANDEX_STATION_RELEASE_ENDPOINT,
      "${{ vars.YANDEX_STATION_RELEASE_ENDPOINT }}",
    );
    assert.match(step.run, /::add-mask::\$AWS_ACCESS_KEY_ID/);
    assert.match(step.run, /::add-mask::\$AWS_SECRET_ACCESS_KEY/);
    assert.match(step.run, /unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN/);
  }
  assert.doesNotMatch(text, /--access-key|--secret-access-key|--credentials/i);
  assert.doesNotMatch(text, /force|:latest\b|pull_request_target|self-hosted|id-token|curl .+\|/i);
  assert.doesNotMatch(text, /continue-on-error/i);
});

test("publish and seed build once and stage two closed origin trees from one input", async () => {
  const workflow = load(await source());
  const build = workflow.jobs.build;
  const signingStep = build.steps.find(
    (step) => step.name === "Build signed Windows NSIS updater artifacts",
  );
  const stageStep = build.steps.find(
    (step) => step.name === "Stage and validate dual-origin release trees",
  );
  const artifactStep = build.steps.find(
    (step) => step.name === "Upload dual-origin release candidate",
  );
  assert.equal((signingStep.run.match(/tauri build/g) ?? []).length, 1);
  assert.equal(stageStep.if, "inputs.mode == 'publish' || inputs.mode == 'seed-baseline'");
  assert.match(
    stageStep.run,
    /artifacts\.mjs stage-origin github beta[\s\S]*\$RUNNER_TEMP\/station-input[\s\S]*\$RUNNER_TEMP\/station-github/,
  );
  assert.match(
    stageStep.run,
    /artifacts\.mjs stage-origin yandex beta[\s\S]*\$RUNNER_TEMP\/station-input[\s\S]*\$RUNNER_TEMP\/station-yandex/,
  );
  assert.match(stageStep.run, /artifacts\.mjs validate-origin github beta/);
  assert.match(stageStep.run, /artifacts\.mjs validate-origin yandex beta/);
  assert.match(stageStep.run, /artifacts\.mjs compare-origins/);
  assert.match(
    stageStep.run,
    /git bundle create "\$RUNNER_TEMP\/station-candidate\/source\.bundle"[\s\\]*HEAD "\^\$GITHUB_SHA"/,
  );
  assert.doesNotMatch(stageStep.run, /git bundle create[^\n]*[\s\\]*"\$release_sha"/);
  assert.equal(artifactStep.if, stageStep.if);
  assert.match(artifactStep.uses, /actions\/upload-artifact@043fb46d/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.release), /tauri build|normalize-signing-key/);
});

test("immutable publication and public dual-origin validation precede every normal promotion", async () => {
  const text = await source();
  const workflow = load(text);
  const steps = workflow.jobs.release.steps;
  const github = steps.find((step) => step.name === "Publish immutable GitHub beta");
  const yandex = steps.find((step) => step.name === "Publish immutable Yandex beta");
  const publicValidation = steps.find(
    (step) => step.name === "Download and validate public immutable trees",
  );
  const promote = steps.find((step) => step.name === "Promote beta mutable targets");
  assert.equal(github.if, "inputs.mode == 'publish' || inputs.mode == 'seed-baseline'");
  assert.equal(yandex.if, "inputs.mode == 'publish'");
  assert.equal(
    publicValidation.if,
    "inputs.mode == 'publish' || inputs.mode == 'promote-existing'",
  );
  assert.ok(steps.indexOf(github) < steps.indexOf(yandex));
  assert.ok(steps.indexOf(yandex) < steps.indexOf(publicValidation));
  assert.ok(steps.indexOf(publicValidation) < steps.indexOf(promote));
  assert.match(github.run, /gh release view "\$tag"[\s\S]*exit 1[\s\S]*gh release create/);
  assert.doesNotMatch(github.run, /release upload[^\n]*--clobber/);
  assert.ok(
    github.run.indexOf('gh release edit "$tag"') <
      github.run.lastIndexOf('gh release download "$tag"'),
  );
  assert.match(yandex.run, /yandex-publisher\.mjs publish-immutable/);
  assert.match(publicValidation.run, /station-github-public/);
  assert.match(publicValidation.run, /station-yandex-public/);
  assert.match(publicValidation.run, /gh release download/);
  assert.match(publicValidation.run, /https:\/\/releases\.markiro\.app\/station\/beta\/releases/);
  assert.match(publicValidation.run, /artifacts\.mjs validate-origin github beta/);
  assert.match(publicValidation.run, /artifacts\.mjs validate-origin yandex beta/);
  assert.match(publicValidation.run, /artifacts\.mjs compare-origins/);
  assert.match(
    publicValidation.run,
    /releaseSha.*\[\[:space:\]\]\*:\[\[:space:\]\]\*.*\$release_sha/,
  );
  assert.doesNotMatch(publicValidation.run, /publish-immutable|tauri build/);
  assert.doesNotMatch(promote.run, /gh release create "\$tag"|publish-immutable|tauri build/);
});

test("one mutable transaction backs up completely, promotes in order and rolls back in reverse", async () => {
  const workflow = load(await source());
  const step = workflow.jobs.release.steps.find(
    (candidate) => candidate.name === "Promote beta mutable targets",
  );
  const run = step.run;
  const githubBackup = run.indexOf(
    'gh release download station-beta-channel --repo "$GITHUB_REPOSITORY" --pattern latest.json',
  );
  const yandexBackup = run.indexOf("yandex-publisher.mjs backup-mutables");
  const githubPromotion = run.indexOf(
    'gh release upload station-beta-channel --repo "$GITHUB_REPOSITORY"',
    githubBackup + 1,
  );
  const yandexPromotion = run.indexOf("yandex-publisher.mjs promote");
  assert.ok(githubBackup >= 0 && githubBackup < yandexBackup);
  assert.ok(yandexBackup < githubPromotion && githubPromotion < yandexPromotion);
  assert.doesNotMatch(run.slice(githubBackup, yandexBackup), /\|\| true/);
  assert.match(run, /trap rollback_transaction EXIT/);
  assert.match(run, /trap 'exit 129' HUP/);
  assert.match(run, /github_may_have_changed=true[\s\S]*gh release upload station-beta-channel/);
  assert.match(run, /yandex_may_have_changed=true[\s\S]*yandex-publisher\.mjs promote/);
  const rollback = run.slice(
    run.indexOf("rollback_transaction()"),
    run.indexOf("trap rollback_transaction EXIT"),
  );
  assert.ok(rollback);
  assert.ok(
    rollback.indexOf("yandex-publisher.mjs rollback") <
      rollback.indexOf("station-github-channel-backup/latest.json"),
  );
  assert.ok(
    rollback.indexOf("yandex-publisher.mjs rollback") <
      rollback.lastIndexOf("unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN"),
  );
  assert.match(rollback, /station-github-rollback-verify/);
  assert.match(rollback, /cmp/);
  assert.match(
    rollback,
    /if ! rm -rf "\$RUNNER_TEMP\/station-github-rollback-verify" \|\|[\s\S]*! mkdir "\$RUNNER_TEMP\/station-github-rollback-verify"/,
  );
  assert.match(rollback, /station release mutable restoration failed/);
  assert.match(run, /yandex-publisher\.mjs seed-baseline[\s\S]*--confirm-empty-channel-bootstrap/);
  assert.match(run, /SEED_INFRASTRUCTURE_EVIDENCE/);
  assert.match(run, /station-bootstrap-record\.json/);
  assert.match(run, /station-yandex-seed-backup/);
  assert.match(run, /station-beta-channel[\s\S]*latest\.json/);
  assert.match(
    run,
    /gh release upload station-beta-channel[^\n]*[\s\S]*\$RUNNER_TEMP\/station-github-channel-upload\/latest\.json" --clobber/,
  );
  assert.doesNotMatch(
    run,
    /gh release upload station-beta-channel[\s\S]*station-beta-latest\.json/,
  );
  assert.doesNotMatch(run, /gh release create station-beta-channel/);
  assert.doesNotMatch(run, /delete-object|DeleteObject/);
});

test("validates raw and wrapped Tauri keys without rewriting them", async () => {
  const raw = "untrusted comment: rsign encrypted secret key\nRWZha2U=\n";
  const wrapped = Buffer.from(raw, "utf8").toString("base64");
  const paddedWrapped = `  ${wrapped}\n`;
  assert.equal(normalizeTauriSigningKey(raw), raw);
  assert.equal(normalizeTauriSigningKey(wrapped), wrapped);
  assert.equal(normalizeTauriSigningKey(paddedWrapped), paddedWrapped);
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
    ["/station/identity", "GET", "content-type,x-api-key,x-station-capabilities"],
    ["/station/operators", "GET", "content-type,x-api-key,x-station-capabilities"],
    [
      "/station/products/00000000-0000-0000-0000-000000000000/image/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "GET",
      "x-api-key,x-station-capabilities",
    ],
    ["/station/conflicts/status", "POST", "content-type,x-api-key,x-station-capabilities"],
    ["/station/codes/releases", "POST", "content-type,x-api-key,x-station-capabilities"],
    ["/station/scans", "POST", "content-type,x-api-key,x-station-capabilities"],
    ["/station/shift-closures", "POST", "content-type,x-api-key,x-station-capabilities"],
    ["/shifts", "GET", "content-type,x-api-key,x-station-capabilities"],
    ["/shifts", "POST", "content-type,x-api-key,x-station-capabilities"],
    ["/shifts/box-label-templates", "GET", "content-type,x-api-key,x-station-capabilities"],
    ["/shifts/cors-probe/open", "POST", "content-type,x-api-key,x-station-capabilities"],
    ["/shifts/cors-probe/bundle", "GET", "content-type,x-api-key,x-station-capabilities"],
    ["/shifts/cors-probe/reference-bundle", "GET", "content-type,x-api-key,x-station-capabilities"],
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
        headers: {
          "Access-Control-Allow-Origin": "http://tauri.localhost",
          "Access-Control-Allow-Methods":
            init.headers["Access-Control-Request-Method"].toLowerCase(),
          "Access-Control-Allow-Headers":
            init.headers["Access-Control-Request-Headers"].toUpperCase(),
        },
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
