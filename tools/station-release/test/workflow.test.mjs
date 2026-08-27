import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { load } from "js-yaml";
import { normalizeTauriSigningKey } from "../normalize-signing-key.mjs";

const root = new URL("../../../", import.meta.url);
const execFile = promisify(execFileCallback);
const source = () => readFile(new URL(".github/workflows/station-beta-release.yml", root), "utf8");
const packageSource = () => readFile(new URL("package.json", root), "utf8");
const distributionRepository = "thevladbog/markiro-station-releases";

test("publishes GitHub release state only to the fixed public binary repository", async () => {
  const text = await source();
  const workflow = load(text);
  assert.equal(workflow.jobs.build.env.STATION_RELEASE_REPOSITORY, distributionRepository);
  assert.equal(workflow.jobs.release.env.STATION_RELEASE_REPOSITORY, distributionRepository);
  assert.doesNotMatch(text, /gh release[^\n]*--repo "\$GITHUB_REPOSITORY"/);
  assert.match(text, /GH_TOKEN:\s*\$\{\{ secrets\.STATION_RELEASE_REPOSITORY_TOKEN \}\}/);
  assert.match(text, /repos\/\$STATION_RELEASE_REPOSITORY\/git\/ref\/heads\/main/);
  assert.match(text, /gh release create "\$tag"[\s\S]*--target "\$distribution_sha"/);
  assert.match(text, /gh run list[\s\S]*--repo "\$GITHUB_REPOSITORY"/);
  assert.match(text, /repos\/\$GITHUB_REPOSITORY\/git\/refs\/heads\/\$candidate_ref/);
});

test("station beta build and dual-origin publication use separate exact protected environments", async () => {
  const text = await source();
  const workflow = load(text);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "mode",
    "owner_confirmation",
    "bump",
    "repair_tag",
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
  assert.equal(workflow.on.workflow_dispatch.inputs.repair_tag.default, "");
  assert.equal(workflow.concurrency.group, "station-beta-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(workflow.jobs), ["authorize", "build", "release"]);
  assert.equal(workflow.jobs.build.needs, "authorize");
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

test("beta publication requires the repository owner, main, and the exact confirmation", async () => {
  const workflow = load(await source());
  const input = workflow.on.workflow_dispatch.inputs.owner_confirmation;
  const authorize = workflow.jobs.authorize;
  const step = authorize.steps.find(
    (candidate) => candidate.name === "Authorize station beta release owner",
  );

  assert.equal(input.required, true);
  assert.equal(input.type, "string");
  assert.equal(authorize.environment, undefined);
  assert.deepEqual(authorize.permissions, {});
  assert.equal(authorize.if, "github.ref == 'refs/heads/main'");
  assert.equal(authorize["runs-on"], "ubuntu-latest");
  assert.equal(authorize["timeout-minutes"], 5);
  assert.ok(step);
  assert.deepEqual(step.env, {
    OWNER_CONFIRMATION: "${{ inputs.owner_confirmation }}",
    RELEASE_ACTOR: "${{ github.actor }}",
    RELEASE_OWNER: "${{ github.repository_owner }}",
  });

  const run = (env) =>
    execFile("bash", ["-c", step.run], {
      env: {
        ...process.env,
        GITHUB_REF: "refs/heads/main",
        OWNER_CONFIRMATION: "PUBLISH-STATION-BETA",
        RELEASE_ACTOR: "thevladbog",
        RELEASE_OWNER: "thevladbog",
        ...env,
      },
    });

  await assert.doesNotReject(run({}));
  await assert.rejects(run({ RELEASE_ACTOR: "another-user" }));
  await assert.rejects(run({ OWNER_CONFIRMATION: "publish-station-beta" }));
  await assert.rejects(run({ GITHUB_REF: "refs/heads/feature" }));
});

test("promote-existing requires one exact beta repair tag and never infers a release", async () => {
  const workflow = load(await source());
  const validate = workflow.jobs.build.steps.find((step) => step.name === "Validate release mode");
  const resolve = workflow.jobs.release.steps.find(
    (step) => step.name === "Resolve release candidate",
  );

  assert.equal(validate.env.REPAIR_TAG, "${{ inputs.repair_tag }}");
  assert.match(validate.run, /if \[ "\$MODE" = "promote-existing" \]; then/);
  assert.match(
    validate.run,
    /\[\[ "\$REPAIR_TAG" =~ \^station-v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)-beta\\\.\(\[1-9\]\[0-9\]\*\)\$ \]\]/,
  );
  assert.match(validate.run, /test -z "\$REPAIR_TAG"/);
  assert.match(validate.run, /test -z "\$SEED_INFRASTRUCTURE_EVIDENCE"/);
  assert.match(validate.run, /test -n "\$SEED_INFRASTRUCTURE_EVIDENCE"/);

  assert.equal(resolve.env.REPAIR_TAG, "${{ inputs.repair_tag }}");
  assert.match(resolve.run, /tag="\$REPAIR_TAG"/);
  assert.match(
    resolve.run,
    /gh release view "\$tag"[\s\S]*--json tagName,isDraft,isPrerelease,targetCommitish/,
  );
  assert.match(resolve.run, /r\.tagName!==process\.argv\[2\]\|\|r\.isDraft\|\|!r\.isPrerelease/);
  assert.doesNotMatch(resolve.run, /gh release list|sort_by|\| last|latest/i);
});

test("beta dispatch validation rejects adversarial repair-tag and mode combinations", async () => {
  const workflow = load(await source());
  const validate = workflow.jobs.build.steps.find((step) => step.name === "Validate release mode");
  const run = ({ mode, repairTag = "", seedEvidence = "" }) =>
    execFile("bash", ["-c", validate.run], {
      env: {
        ...process.env,
        MODE: mode,
        REPAIR_TAG: repairTag,
        SEED_INFRASTRUCTURE_EVIDENCE: seedEvidence,
      },
    });

  await assert.doesNotReject(run({ mode: "promote-existing", repairTag: "station-v1.2.3-beta.4" }));
  await assert.doesNotReject(run({ mode: "publish" }));
  await assert.doesNotReject(run({ mode: "seed-baseline", seedEvidence: "{}" }));
  for (const input of [
    { mode: "promote-existing" },
    { mode: "promote-existing", repairTag: "station-v1.2.3-beta.0" },
    { mode: "promote-existing", repairTag: " station-v1.2.3-beta.4" },
    { mode: "promote-existing", repairTag: "station-v1.2.3" },
    { mode: "promote-existing", repairTag: "station-v1.2.3-beta.4; true" },
    { mode: "publish", repairTag: "station-v1.2.3-beta.4" },
    { mode: "publish", seedEvidence: "{}" },
    { mode: "seed-baseline", repairTag: "station-v1.2.3-beta.4", seedEvidence: "{}" },
    { mode: "seed-baseline" },
    { mode: "repair", repairTag: "station-v1.2.3-beta.4" },
  ]) {
    await assert.rejects(run(input), /Command failed/, JSON.stringify(input));
  }
});

test("publish and seed build once and stage two closed origin trees from one input", async () => {
  const workflow = load(await source());
  const build = workflow.jobs.build;
  const verifyStep = build.steps.find((step) => step.name === "Build and verify station");
  const signingStep = build.steps.find(
    (step) => step.name === "Build signed Windows NSIS updater artifacts",
  );
  const stageStep = build.steps.find(
    (step) => step.name === "Stage and validate dual-origin release trees",
  );
  const artifactStep = build.steps.find(
    (step) => step.name === "Upload dual-origin release candidate",
  );
  assert.match(
    verifyStep.run,
    /if \[ "\$\{\{ inputs\.mode \}\}" = "seed-baseline" \]; then[\s\S]*cargo test --manifest-path apps\/station\/src-tauri\/Cargo\.toml --features legacy-github-updater[\s\S]*fi/,
  );
  assert.equal((signingStep.run.match(/tauri build/g) ?? []).length, 1);
  assert.match(
    signingStep.run,
    /set --[\s\S]*if \[ "\$\{\{ inputs\.mode \}\}" = "seed-baseline" \]; then[\s\S]*set -- --features legacy-github-updater --config src-tauri\/tauri\.beta-seed\.conf\.json[\s\S]*fi[\s\S]*tauri build "\$@"/,
  );
  assert.match(
    signingStep.run,
    /if \[ "\$\{\{ inputs\.mode \}\}" = "seed-baseline" \]; then[\s\S]*verify-seed-updater-binary\.mjs apps\/station\/src-tauri\/target\/release\/markiro-station\.exe[\s\S]*fi/,
  );
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

test("immutable publication and public dual-origin validation precede every mode's mutable work", async () => {
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
  assert.equal(yandex.if, "inputs.mode == 'publish' || inputs.mode == 'seed-baseline'");
  assert.equal(
    publicValidation.if,
    "inputs.mode == 'publish' || inputs.mode == 'promote-existing' || inputs.mode == 'seed-baseline'",
  );
  assert.ok(steps.indexOf(github) < steps.indexOf(yandex));
  assert.ok(steps.indexOf(yandex) < steps.indexOf(publicValidation));
  assert.ok(steps.indexOf(publicValidation) < steps.indexOf(promote));
  assert.match(github.run, /gh release view "\$tag"[\s\S]*exit 1[\s\S]*gh release create/);
  assert.doesNotMatch(github.run, /release upload[^\n]*--clobber/);
  assert.ok(github.run.indexOf('gh release edit "$tag"') < github.run.indexOf("github-public.mjs"));
  assert.match(
    github.run,
    /env -u GH_TOKEN -u GITHUB_TOKEN node tools\/station-release\/github-public\.mjs[\s\\]*download-release beta "\$version"/,
  );
  const seedImmutableBranch = yandex.run.slice(
    yandex.run.indexOf('"seed-baseline" ]; then'),
    yandex.run.indexOf("else"),
  );
  const normalImmutableBranch = yandex.run.slice(
    yandex.run.indexOf("else"),
    yandex.run.lastIndexOf("fi"),
  );
  assert.match(seedImmutableBranch, /yandex-publisher\.mjs prepare-seed-immutable/);
  assert.doesNotMatch(seedImmutableBranch, /yandex-publisher\.mjs publish-immutable/);
  assert.match(normalImmutableBranch, /yandex-publisher\.mjs publish-immutable/);
  assert.doesNotMatch(normalImmutableBranch, /prepare-seed-immutable/);
  assert.match(publicValidation.run, /station-github-public/);
  assert.match(publicValidation.run, /station-yandex-public/);
  assert.match(
    publicValidation.run,
    /env -u GH_TOKEN -u GITHUB_TOKEN node tools\/station-release\/github-public\.mjs[\s\\]*download-release beta "\$version"/,
  );
  assert.doesNotMatch(publicValidation.run, /gh release download/);
  assert.equal(
    publicValidation.env.YANDEX_STATION_RELEASE_BUCKET,
    "${{ vars.YANDEX_STATION_RELEASE_BUCKET }}",
  );
  const seedPublicStart = publicValidation.run.lastIndexOf('"seed-baseline" ]; then');
  const seedPublicElse = publicValidation.run.indexOf("else", seedPublicStart);
  const seedPublicBranch = publicValidation.run.slice(seedPublicStart, seedPublicElse);
  const normalPublicBranch = publicValidation.run.slice(
    seedPublicElse,
    publicValidation.run.indexOf("fi", seedPublicElse),
  );
  assert.match(
    seedPublicBranch,
    /https:\/\/storage\.yandexcloud\.net\/\$YANDEX_STATION_RELEASE_BUCKET\/station\/beta\/releases/,
  );
  assert.doesNotMatch(seedPublicBranch, /https:\/\/releases\.markiro\.app/);
  assert.match(normalPublicBranch, /https:\/\/releases\.markiro\.app\/station\/beta\/releases/);
  assert.doesNotMatch(normalPublicBranch, /storage\.yandexcloud\.net/);
  assert.match(publicValidation.run, /artifacts\.mjs validate-origin github beta/);
  assert.match(publicValidation.run, /artifacts\.mjs validate-origin yandex beta/);
  assert.match(publicValidation.run, /artifacts\.mjs compare-origins/);
  assert.match(
    publicValidation.run,
    /curl --fail[^\n]*--retry 3 --retry-all-errors --retry-max-time 30/,
  );
  assert.match(publicValidation.run, /RELEASE_SHA="\$release_sha" node -e/);
  assert.match(publicValidation.run, /e\.releaseSha!==process\.env\.RELEASE_SHA/);
  assert.match(publicValidation.run, /"\$yandex_public\/release-evidence\.json"/);
  assert.doesNotMatch(publicValidation.run, /grep -o[\s\S]*wc -l/);
  assert.doesNotMatch(publicValidation.run, /publish-immutable|tauri build/);
  assert.doesNotMatch(promote.run, /gh release create "\$tag"|publish-immutable|tauri build/);
  assert.equal(
    [...promote.run.matchAll(/curl --fail[^\n]*--retry 3 --retry-all-errors --retry-max-time 30/g)]
      .length,
    2,
  );
});

test("one mutable transaction backs up completely, promotes in order and rolls back in reverse", async () => {
  const workflow = load(await source());
  const step = workflow.jobs.release.steps.find(
    (candidate) => candidate.name === "Promote beta mutable targets",
  );
  const run = step.run;
  const githubBackup = run.indexOf(
    '"$RUNNER_TEMP/station-github-channel-backup/latest.json"',
    run.indexOf("trap rollback_transaction EXIT"),
  );
  const yandexBackup = run.indexOf("yandex-publisher.mjs backup-mutables");
  const seedPreflight = run.indexOf("yandex-publisher.mjs preflight-seed-mutables");
  const githubPromotion = run.indexOf(
    'gh release upload station-beta-channel --repo "$STATION_RELEASE_REPOSITORY"',
    githubBackup + 1,
  );
  const yandexPromotion = run.indexOf("yandex-publisher.mjs promote");
  const yandexSeed = run.indexOf("yandex-publisher.mjs seed-baseline");
  assert.ok(githubBackup >= 0 && githubBackup < yandexBackup);
  assert.ok(yandexBackup < githubPromotion && githubPromotion < yandexPromotion);
  assert.ok(githubBackup < seedPreflight && seedPreflight < githubPromotion);
  assert.ok(githubPromotion < yandexSeed);
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
  assert.match(rollback, /github_channel_preexisting[\s\S]*gh release delete station-beta-channel/);
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
  assert.match(
    run,
    /if \[ "\$\{\{ inputs\.mode \}\}" = "seed-baseline" \]; then[\s\S]*gh release create station-beta-channel[\s\S]*else[\s\S]*gh release upload station-beta-channel/,
  );
  assert.doesNotMatch(run, /delete-object|DeleteObject/);
  assert.equal((run.match(/download-channel beta/g) ?? []).length, 3);
  assert.doesNotMatch(run, /gh release download station-beta-channel/);
  assert.match(
    run,
    /beta-transition[\s\\]*"\$RUNNER_TEMP\/station-beta-release-summary\.json" restored/,
  );
  assert.match(
    run,
    /beta-transition[\s\\]*"\$RUNNER_TEMP\/station-beta-release-summary\.json" restoration-failed/,
  );
});

test("beta terminal summary is initialized early, tracks every boundary, and always renders bounded state", async () => {
  const workflow = load(await source());
  const steps = workflow.jobs.release.steps;
  const initialize = steps.find((step) => step.name === "Initialize bounded beta release summary");
  const resolve = steps.find((step) => step.name === "Resolve release candidate");
  const record = steps.find((step) => step.name === "Record beta release summary provenance");
  const github = steps.find((step) => step.name === "Publish immutable GitHub beta");
  const publicValidation = steps.find(
    (step) => step.name === "Download and validate public immutable trees",
  );
  const promote = steps.find((step) => step.name === "Promote beta mutable targets");
  const summary = steps.find((step) => step.name === "Write bounded beta release summary");
  assert.ok(steps.indexOf(initialize) < steps.indexOf(resolve));
  assert.ok(steps.indexOf(record) < steps.indexOf(github));
  assert.equal(summary.if, "always()");
  assert.match(summary.run, /beta-render/);
  assert.match(summary.run, /GITHUB_STEP_SUMMARY/);
  assert.match(summary.run, /External acceptance: `NOT_RUN`/);
  for (const label of [
    "Mode",
    "Version",
    "Source commit",
    "Release commit",
    "GitHub manifest SHA-256",
    "Yandex manifest SHA-256",
    "GitHub evidence SHA-256",
    "Yandex evidence SHA-256",
    "Installer SHA-256",
    "Updater bundle SHA-256",
    "Detached signature SHA-256",
    "Immutable publication",
    "Promotion",
    "Rollback/restoration",
    "Outcome",
  ]) {
    assert.match(summary.run, new RegExp(`- ${label}:`));
  }
  for (const event of [
    "github-publication-attempted",
    "github-draft-created",
    "github-assets-uploaded",
    "github-draft-assets-validated",
    "github-undraft-attempted",
    "github-public-validated",
  ]) {
    assert.match(github.run, new RegExp(event));
  }
  for (const event of ["existing-public-validation-started", "both-public-validated"]) {
    assert.match(publicValidation.run, new RegExp(event));
  }
  for (const event of [
    "mutable-backup-complete",
    "github-manifest-promoted",
    "yandex-manifest-promoted",
    "all-promoted",
    "restored",
    "restoration-failed",
  ]) {
    assert.match(promote.run, new RegExp(event));
  }
  assert.match(publicValidation.run, /githubManifestSha256/);
  assert.match(publicValidation.run, /yandexManifestSha256/);
  assert.match(publicValidation.run, /githubEvidenceSha256/);
  assert.match(publicValidation.run, /yandexEvidenceSha256/);
  assert.match(publicValidation.run, /installerSha256/);
  assert.match(publicValidation.run, /bundleSha256/);
  assert.match(publicValidation.run, /signatureSha256/);
  assert.doesNotMatch(summary.run, /AWS_|GH_TOKEN|secret|station-candidate/);
  assert.ok(Buffer.byteLength(summary.run) < 8192);
});

test("seed and normal modes use disjoint publisher branches under one compensation trap", async () => {
  const workflow = load(await source());
  const step = workflow.jobs.release.steps.find(
    (candidate) => candidate.name === "Promote beta mutable targets",
  );
  const run = step.run;
  const preflightIndex = run.indexOf("preflight-seed-mutables");
  const branchStart = run.lastIndexOf('"seed-baseline" ]; then', preflightIndex);
  const branchElse = run.indexOf("else", preflightIndex);
  const branchEnd = run.indexOf("fi", branchElse);
  const seedPreflightBranch = run.slice(branchStart, branchElse);
  const normalBackupBranch = run.slice(branchElse, branchEnd);
  assert.match(seedPreflightBranch, /preflight-seed-mutables/);
  assert.doesNotMatch(seedPreflightBranch, /backup-mutables|yandex-publisher\.mjs promote/);
  assert.match(normalBackupBranch, /backup-mutables/);
  assert.doesNotMatch(normalBackupBranch, /preflight-seed-mutables|seed-baseline/);

  const seedPromotionStart = run.lastIndexOf('"seed-baseline" ]; then');
  const seedPromotionElse = run.indexOf("else", seedPromotionStart);
  const seedPromotionEnd = run.indexOf("fi", seedPromotionElse);
  const seedPromotionBranch = run.slice(seedPromotionStart, seedPromotionElse);
  const normalPromotionBranch = run.slice(seedPromotionElse, seedPromotionEnd);
  assert.match(seedPromotionBranch, /yandex-publisher\.mjs seed-baseline/);
  assert.doesNotMatch(seedPromotionBranch, /yandex-publisher\.mjs promote\s/);
  assert.match(normalPromotionBranch, /yandex-publisher\.mjs promote\s/);
  assert.doesNotMatch(normalPromotionBranch, /yandex-publisher\.mjs seed-baseline/);
  assert.ok(run.indexOf("trap rollback_transaction EXIT") < seedPromotionStart);
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
    ["/station/inventory-tasks", "GET", "content-type,x-api-key,x-station-capabilities"],
    [
      "/station/inventory-tasks/resolve-barcode",
      "POST",
      "content-type,x-api-key,x-station-capabilities",
    ],
    [
      "/station/inventories/cors-probe/join",
      "POST",
      "content-type,x-api-key,x-station-capabilities",
    ],
    [
      "/station/inventories/cors-probe/bundle/manifest",
      "GET",
      "content-type,x-api-key,x-station-capabilities",
    ],
    [
      "/station/inventories/cors-probe/bundle/codes",
      "GET",
      "content-type,x-api-key,x-station-capabilities",
    ],
    [
      "/station/inventories/cors-probe/event-batches",
      "POST",
      "content-type,x-api-key,x-station-capabilities",
    ],
    [
      "/station/inventories/cors-probe/progress",
      "GET",
      "content-type,x-api-key,x-station-capabilities",
    ],
    [
      "/station/inventories/cors-probe/leave",
      "POST",
      "content-type,x-api-key,x-station-capabilities",
    ],
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
