import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

const root = new URL("../../../", import.meta.url);
const source = () =>
  readFile(new URL(".github/workflows/station-stable-release.yml", root), "utf8");

function workflowStep(workflow, job, name) {
  const step = workflow.jobs[job].steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing ${job} step: ${name}`);
  return step;
}

test("stable signing and dual-origin publication use separate protected environments", async () => {
  const text = await source();
  const workflow = load(text);

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "mode",
    "source_beta_tag",
    "acceptance_confirmed",
    "highlights",
    "seed_stable_tag",
    "seed_infrastructure_evidence",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
    "publish",
    "promote-existing",
    "seed-baseline",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.acceptance_confirmed.default, false);
  assert.equal(workflow.concurrency.group, "station-stable-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(workflow.jobs), ["build", "release"]);
  assert.equal(workflow.jobs.build.environment, "station-stable");
  assert.equal(workflow.jobs.build["runs-on"], "windows-latest");
  assert.deepEqual(workflow.jobs.build.permissions, { actions: "read", contents: "read" });
  assert.equal(workflow.jobs.release.environment, "station-release");
  assert.equal(workflow.jobs.release["runs-on"], "windows-latest");
  assert.equal(workflow.jobs.release.needs, "build");
  assert.deepEqual(workflow.jobs.release.permissions, { actions: "read", contents: "write" });
  assert.equal(workflow.jobs.build.env.VITE_STATION_API_URL, "https://admin.markiro.app");
  assert.equal(workflow.jobs.build.env.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(workflow.jobs.release.env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(workflow.jobs.release.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.build), /YANDEX_STATION_RELEASE/);

  const signing = workflowStep(workflow, "build", "Build signed stable Windows artifacts");
  assert.equal(signing.if, "inputs.mode == 'publish'");
  assert.equal((signing.run.match(/tauri build/g) ?? []).length, 1);
  assert.match(signing.run, /--config src-tauri\/tauri\.stable\.conf\.json/);
  assert.match(
    signing.run,
    /printf '%s' "\$TAURI_SIGNING_PRIVATE_KEY" \| node tools\/station-release\/normalize-signing-key\.mjs > \/dev\/null/,
  );
  assert.match(signing.run, /printf '%s' "\$TAURI_SIGNING_PRIVATE_KEY" > "\$signing_key_file"/);
  assert.doesNotMatch(signing.run, /normalized_key=/);

  const credentialSteps = workflow.jobs.release.steps.filter((step) =>
    JSON.stringify(step.env ?? {}).includes("YANDEX_STATION_RELEASE_ACCESS_KEY_ID"),
  );
  assert.equal(credentialSteps.length, 4);
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

  assert.match(text, /refs\/heads\/main/);
  assert.match(text, /persist-credentials:\s*false/);
  assert.doesNotMatch(text, /--access-key|--secret-access-key|--credentials/i);
  assert.doesNotMatch(text, /pull_request_target|self-hosted|id-token|continue-on-error/i);
});

test("normal stable modes validate the exact beta at both origins before rebuilding baseSha", async () => {
  const workflow = load(await source());
  const steps = workflow.jobs.build.steps;
  const accepted = workflowStep(workflow, "build", "Resolve and verify dual-origin accepted beta");
  const prepare = workflowStep(workflow, "build", "Prepare stable release source");
  const build = workflowStep(workflow, "build", "Build and verify stable source");
  const signing = workflowStep(workflow, "build", "Build signed stable Windows artifacts");

  assert.equal(accepted.if, "inputs.mode == 'publish' || inputs.mode == 'promote-existing'");
  assert.ok(steps.indexOf(accepted) < steps.indexOf(prepare));
  assert.ok(steps.indexOf(prepare) < steps.indexOf(build));
  assert.ok(steps.indexOf(build) < steps.indexOf(signing));
  assert.match(accepted.run, /gh release view "\$source_beta_tag"/);
  assert.match(accepted.run, /gh release download "\$source_beta_tag"/);
  assert.match(
    accepted.run,
    /https:\/\/releases\.markiro\.app\/station\/beta\/releases\/\$beta_version/,
  );
  assert.match(accepted.run, /artifacts\.mjs validate-origin github beta/);
  assert.match(accepted.run, /artifacts\.mjs validate-origin yandex beta/);
  assert.match(accepted.run, /artifacts\.mjs compare-origins/);
  assert.match(
    accepted.run,
    /promotion\.mjs validate-beta[\s\\]*"\$beta_release_json"[\s\\]*"\$github_evidence_path"[\s\\]*"\$yandex_evidence_path"/,
  );
  assert.match(accepted.run, /test "\$beta_release_sha" = "\$beta_target_sha"/);
  assert.match(accepted.run, /git merge-base --is-ancestor "\$base_sha" origin\/main/);
  assert.match(accepted.run, /--commit "\$base_sha"/);
  assert.match(accepted.run, /stable-boundary\.mjs resolve-state/);
  assert.match(accepted.run, /gh release list[\s\S]*--limit 10001/);
  assert.match(accepted.run, /--json tagName,isDraft,isPrerelease,publishedAt > "\$releases_file"/);
  assert.doesNotMatch(accepted.run, /gh release list[^\n]*targetCommitish/);
  assert.equal(prepare.if, "inputs.mode == 'publish'");
  assert.match(prepare.run, /git checkout --detach "\$base_sha"/);
  assert.match(prepare.run, /git rev-parse HEAD\^/);
  assert.equal(build.if, "inputs.mode == 'publish'");
});

test("publish stages two stable trees from one build and keeps stable provenance identical", async () => {
  const workflow = load(await source());
  const stage = workflowStep(workflow, "build", "Stage and validate dual-origin stable trees");
  const upload = workflowStep(workflow, "build", "Upload dual-origin stable candidate");

  assert.equal(stage.if, "inputs.mode == 'publish'");
  assert.match(stage.run, /github_tree="\$RUNNER_TEMP\/station-stable-github"/);
  assert.match(stage.run, /yandex_tree="\$RUNNER_TEMP\/station-stable-yandex"/);
  assert.match(
    stage.run,
    /artifacts\.mjs stage-origin github stable[\s\\]*"\$RUNNER_TEMP\/station-stable-input" "\$github_tree"/,
  );
  assert.match(
    stage.run,
    /artifacts\.mjs stage-origin yandex stable[\s\\]*"\$RUNNER_TEMP\/station-stable-input" "\$yandex_tree"/,
  );
  assert.match(stage.run, /"\$notes_path" "\$provenance_path"/);
  assert.match(stage.run, /artifacts\.mjs validate-origin github stable/);
  assert.match(stage.run, /artifacts\.mjs validate-origin yandex stable/);
  assert.match(stage.run, /artifacts\.mjs compare-origins/);
  assert.match(stage.run, /stable-boundary\.mjs resolve-changelog/);
  assert.match(stage.run, /github-public\.mjs[\s\\]*download-release/);
  assert.doesNotMatch(stage.run, /git tag --list|candidate_release_sha|earliest_base_sha/);
  assert.match(
    stage.run,
    /git bundle create "\$RUNNER_TEMP\/station-stable-candidate\/source\.bundle"[\s\\]*HEAD "\^\$base_sha"/,
  );
  assert.equal(upload.if, "inputs.mode == 'publish'");
  assert.match(upload.uses, /actions\/upload-artifact@043fb46d/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.release), /tauri build|normalize-signing-key/);
});

test("both public stable trees are proven before the complete mutable transaction", async () => {
  const workflow = load(await source());
  const steps = workflow.jobs.release.steps;
  const github = workflowStep(workflow, "release", "Publish immutable GitHub stable");
  const yandex = workflowStep(workflow, "release", "Publish immutable Yandex stable");
  const publicValidation = workflowStep(
    workflow,
    "release",
    "Download and validate public immutable stable trees",
  );
  const promote = workflowStep(workflow, "release", "Promote stable mutable targets");
  const resolve = workflowStep(workflow, "release", "Resolve stable publication candidate");

  assert.equal(github.if, "inputs.mode == 'publish'");
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
  assert.match(github.run, /github-public\.mjs[\s\\]*download-release stable "\$version"/);
  assert.match(
    yandex.run,
    /yandex-publisher\.mjs publish-immutable[\s\\]*"\$RUNNER_TEMP\/station-stable-candidate\/yandex" stable "\$version"/,
  );
  assert.match(publicValidation.run, /station-stable-github-public/);
  assert.match(publicValidation.run, /station-stable-yandex-public/);
  assert.match(publicValidation.run, /unset GH_TOKEN GITHUB_TOKEN/);
  assert.match(
    publicValidation.run,
    /github-public\.mjs[\s\\]*download-release[\s\\]*stable "\$version"/,
  );
  assert.doesNotMatch(publicValidation.run, /gh release download/);
  assert.match(
    publicValidation.run,
    /https:\/\/releases\.markiro\.app\/station\/stable\/releases\/\$version/,
  );
  assert.match(publicValidation.run, /artifacts\.mjs validate-origin github stable/);
  assert.match(publicValidation.run, /artifacts\.mjs validate-origin yandex stable/);
  assert.match(publicValidation.run, /artifacts\.mjs compare-origins/);
  assert.match(
    publicValidation.run,
    /yandex-publisher\.mjs validate-public[\s\\]*"\$yandex_public" stable "\$version"/,
  );
  assert.ok(
    steps.indexOf(publicValidation) < steps.indexOf(promote) &&
      publicValidation.run.indexOf("yandex-publisher.mjs validate-public") >= 0 &&
      promote.run.indexOf("yandex-publisher.mjs backup-mutables stable") >= 0,
  );
  assert.match(resolve.run, /sourceBetaTag "\$source_beta_tag"/);
  assert.match(resolve.run, /baseSha "\$base_sha"/);
  assert.match(resolve.run, /releaseSha "\$release_sha"/);
  assert.match(resolve.run, /githubBetaEvidenceSha256 "\$github_beta_evidence_sha256"/);
  assert.match(resolve.run, /yandexBetaEvidenceSha256 "\$yandex_beta_evidence_sha256"/);
  assert.doesNotMatch(publicValidation.run, /publish-immutable|tauri build/);
  assert.doesNotMatch(promote.run, /gh release create "\$tag"|publish-immutable|tauri build/);
});

test("stable mutables promote GitHub, Yandex manifest, then the default stable alias and roll back in reverse", async () => {
  const workflow = load(await source());
  const step = workflowStep(workflow, "release", "Promote stable mutable targets");
  const run = step.run;
  const githubBackup = run.indexOf(
    'gh release download station-stable-channel --repo "$GITHUB_REPOSITORY" --pattern latest.json',
  );
  const yandexBackup = run.indexOf("yandex-publisher.mjs backup-mutables stable");
  const githubPromotion = run.indexOf(
    'gh release upload station-stable-channel --repo "$GITHUB_REPOSITORY"',
    githubBackup + 1,
  );
  const yandexPromotion = run.indexOf("yandex-publisher.mjs promote", yandexBackup + 1);
  assert.ok(githubBackup >= 0 && githubBackup < yandexBackup);
  assert.ok(yandexBackup < githubPromotion && githubPromotion < yandexPromotion);
  assert.doesNotMatch(run.slice(githubBackup, yandexBackup), /\|\| true/);
  assert.match(run, /trap rollback_transaction EXIT/);
  assert.match(run, /github_may_have_changed=true[\s\S]*gh release upload station-stable-channel/);
  assert.match(run, /yandex_may_have_changed=true[\s\S]*yandex-publisher\.mjs promote/);
  const rollback = run.slice(
    run.indexOf("rollback_transaction()"),
    run.indexOf("trap rollback_transaction EXIT"),
  );
  assert.ok(
    rollback.indexOf("yandex-publisher.mjs rollback stable") <
      rollback.indexOf("station-stable-github-channel-backup/latest.json"),
  );
  assert.match(rollback, /station-stable-github-rollback-verify/);
  assert.match(rollback, /github-public\.mjs download-channel stable/);
  assert.doesNotMatch(rollback, /gh release download station-stable-channel/);
  assert.match(rollback, /station release mutable restoration failed/);
  assert.match(run, /https:\/\/releases\.markiro\.app\/station\/stable\/latest\.json/);
  assert.match(run, /https:\/\/releases\.markiro\.app\/station\/download/);
  assert.match(run, /github-public\.mjs download-channel stable/);
  assert.doesNotMatch(run, /station\/beta\/download/);
  assert.doesNotMatch(run, /gh release create station-stable-channel/);
  assert.doesNotMatch(run, /delete-object|DeleteObject/);
});

test("one-time stable seed uses the latest legacy stable only while release DNS is disabled", async () => {
  const workflow = load(await source());
  const validate = workflowStep(workflow, "build", "Validate stable dispatch inputs");
  const seed = workflowStep(workflow, "release", "Seed legacy stable rollback baseline");
  const immutable = workflowStep(workflow, "release", "Publish immutable Yandex stable");
  const publicValidation = workflowStep(
    workflow,
    "release",
    "Download and validate public immutable stable trees",
  );
  const promote = workflowStep(workflow, "release", "Promote stable mutable targets");

  assert.match(validate.run, /if \[ "\$MODE" = "seed-baseline" \]/);
  assert.match(validate.run, /test -z "\$SOURCE_BETA_TAG"/);
  assert.match(validate.run, /test "\$ACCEPTANCE_CONFIRMED" = "false"/);
  assert.match(validate.run, /SEED_STABLE_TAG/);
  assert.match(validate.run, /SEED_INFRASTRUCTURE_EVIDENCE/);
  assert.equal(seed.if, "inputs.mode == 'seed-baseline'");
  assert.match(seed.run, /gh release list[\s\S]*--limit 10001/);
  assert.match(seed.run, /stable-boundary\.mjs resolve-latest-stable/);
  assert.match(seed.run, /test "\$seed_stable_tag" = "\$latest_stable_tag"/);
  assert.match(seed.run, /github-public\.mjs[\s\\]*download-release stable/);
  assert.doesNotMatch(seed.run, /gh release download "\$seed_stable_tag"/);
  assert.match(
    seed.run,
    /yandex-publisher\.mjs seed-baseline[\s\S]* stable[\s\\]*[\s\S]*--confirm-empty-channel-bootstrap/,
  );
  assert.match(seed.run, /SEED_INFRASTRUCTURE_EVIDENCE/);
  assert.doesNotMatch(
    seed.run,
    /promotion\.mjs validate-beta|station-beta\/releases|station\/beta/,
  );
  assert.doesNotMatch(seed.run, /gh release upload station-stable-channel|gh release create/);
  assert.equal(immutable.if, "inputs.mode == 'publish'");
  assert.equal(
    publicValidation.if,
    "inputs.mode == 'publish' || inputs.mode == 'promote-existing'",
  );
  assert.equal(promote.if, "inputs.mode == 'publish' || inputs.mode == 'promote-existing'");
});

test("always emits a bounded publication and compensation summary", async () => {
  const workflow = load(await source());
  const summary = workflowStep(workflow, "release", "Summarize stable release");
  const github = workflowStep(workflow, "release", "Publish immutable GitHub stable");
  const yandex = workflowStep(workflow, "release", "Publish immutable Yandex stable");
  const publicValidation = workflowStep(
    workflow,
    "release",
    "Download and validate public immutable stable trees",
  );
  const promote = workflowStep(workflow, "release", "Promote stable mutable targets");

  assert.equal(summary.if, "always()");
  assert.match(summary.run, /release-summary\.mjs render/);
  assert.doesNotMatch(summary.run, /\$\{\{ toJSON\(|error\.message|stderr|stdout/);
  const githubAttempted = github.run.indexOf("github-publication-attempted");
  const githubCreate = github.run.indexOf('gh release create "$tag"');
  const githubCreated = github.run.indexOf("github-draft-created");
  const githubUpload = github.run.indexOf('gh release upload "$tag"');
  const githubAssetsValidated = github.run.indexOf("github-draft-assets-validated");
  const githubUndraftAttempted = github.run.indexOf("github-undraft-attempted");
  const githubUndraft = github.run.indexOf('gh release edit "$tag"');
  const githubPublicValidated = github.run.indexOf("github-public-validated");
  assert.ok(githubAttempted >= 0 && githubAttempted < githubCreate);
  assert.ok(githubCreate < githubCreated && githubCreated < githubUpload);
  assert.ok(githubUpload < githubAssetsValidated);
  assert.ok(githubAssetsValidated < githubUndraftAttempted);
  assert.ok(githubUndraftAttempted < githubUndraft && githubUndraft < githubPublicValidated);
  const yandexAttempted = yandex.run.indexOf("yandex-publication-attempted");
  const yandexPublish = yandex.run.indexOf("yandex-publisher.mjs publish-immutable");
  const bothPublished = yandex.run.indexOf("both-origin-published");
  assert.ok(yandexAttempted >= 0 && yandexAttempted < yandexPublish);
  assert.ok(yandexPublish < bothPublished);
  assert.match(publicValidation.run, /githubManifestSha256/);
  assert.match(publicValidation.run, /yandexEvidenceSha256/);
  assert.match(publicValidation.run, /installerSha256/);
  assert.match(publicValidation.run, /existing-public-validation-started/);
  assert.match(publicValidation.run, /both-public-validated/);
  assert.match(promote.run, /github-promoted/);
  assert.match(promote.run, /all-promoted/);
  assert.match(promote.run, /restored/);
  assert.match(promote.run, /restoration-failed/);
});
