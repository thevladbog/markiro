import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { load } from "js-yaml";
import {
  requireMainCiRun,
  verifyCiGate,
  verifyApkPackage,
  verifySigningCertificate,
} from "../stable-release.mjs";
import { resolvePublicationSource } from "../publish.mjs";

const sourceSha = "a".repeat(40);
const publisherSha = "b".repeat(40);
const repository = { id: 123 };
const run = {
  id: 456,
  run_attempt: 2,
  path: ".github/workflows/ci.yml",
  repository,
  head_repository: repository,
  head_sha: sourceSha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
};
const gate = {
  name: "ci-required",
  run_id: run.id,
  run_attempt: run.run_attempt,
  head_sha: sourceSha,
  status: "completed",
  conclusion: "success",
};

test("requires successful main-push CI for the exact product revision and repository", () => {
  assert.deepEqual(requireMainCiRun([run], sourceSha, "123"), { id: 456, attempt: 2 });
  for (const patch of [
    { path: ".github/workflows/another.yml" },
    { head_repository: { id: 789 } },
    { repository: { id: 789 } },
    { head_sha: publisherSha },
    { head_branch: "candidate" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { run_attempt: 0 },
  ]) {
    assert.throws(() => requireMainCiRun([{ ...run, ...patch }], sourceSha, "123"));
  }
});

test("requires a unique successful ci-required job on the verified run attempt", () => {
  assert.doesNotThrow(() => verifyCiGate([gate], sourceSha, { id: 456, attempt: 2 }));
  for (const jobs of [
    [],
    [gate, gate],
    [{ ...gate, head_sha: publisherSha }],
    [{ ...gate, run_attempt: 1 }],
    [{ ...gate, run_id: 789 }],
    [{ ...gate, conclusion: "skipped" }],
  ]) {
    assert.throws(() => verifyCiGate(jobs, sourceSha, { id: 456, attempt: 2 }));
  }
});

test("validates package, release version, and non-debuggable APK before signing", () => {
  const badging = "package: name='app.markiro.handheld' versionCode='26' versionName='1.9.1'\n";
  assert.doesNotThrow(() => verifyApkPackage(badging, "1.9.1", "26"));
  for (const output of [
    badging + "application-debuggable\n",
    badging.replace("app.markiro.handheld", "app.other"),
    badging.replace("26", "27"),
    badging.replace("1.9.1", "1.9.2"),
    badging + badging,
  ]) {
    assert.throws(() => verifyApkPackage(output, "1.9.1", "26"));
  }
});

test("signing must keep exactly one existing Android signing certificate", () => {
  const digest = "27e453b2b40d3d1e4b58917acfb9c6c908036b72d6e48e3759a9e8efd5e6a3f7";
  const output = `Number of signers: 1\nSigner #1 certificate SHA-256 digest: ${digest}\n`;
  assert.doesNotThrow(() => verifySigningCertificate(output));
  assert.doesNotThrow(() => verifySigningCertificate(output.replace("Signer #1", "V2 Signer:")));
  assert.throws(() => verifySigningCertificate(output.replace(digest, "0".repeat(64))));
  assert.throws(() => verifySigningCertificate(output + output));
  assert.throws(() => verifySigningCertificate(output.replace("signers: 1", "signers: 2")));
});

test("stable tag publication records product SHA independently of the publisher SHA", () => {
  const env = { GITHUB_REF: "refs/tags/handheld-publisher-v1", GITHUB_SHA: publisherSha };
  assert.equal(resolvePublicationSource({ ...env, HANDHELD_SOURCE_SHA: sourceSha }), sourceSha);
  assert.throws(() => resolvePublicationSource(env));
  assert.throws(() => resolvePublicationSource({ ...env, HANDHELD_SOURCE_SHA: "main" }));
  assert.equal(
    resolvePublicationSource({ GITHUB_REF: "refs/heads/main", GITHUB_SHA: sourceSha }),
    sourceSha,
  );
  assert.throws(() =>
    resolvePublicationSource({
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: sourceSha,
      HANDHELD_SOURCE_SHA: publisherSha,
    }),
  );
});

test("the stable workflow isolates the key and OIDC from the product checkout", () => {
  const workflow = load(readFileSync(".github/workflows/handheld-stable-release.yml", "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["mode", "bump"]);
  assert.equal(inputs.mode.default, "publish");
  assert.deepEqual(inputs.mode.options, ["publish", "verify"]);
  assert.equal(workflow.concurrency.group, "handheld-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const { authorize, build, publish, verify } = workflow.jobs;
  assert.match(authorize.if, /inputs\.mode == 'publish'/u);
  assert.match(publish.if, /inputs\.mode == 'publish'/u);
  assert.match(authorize.if, /refs\/tags\/handheld-publisher-v1/);
  assert.match(authorize.if, /github\.actor == github\.repository_owner/);
  assert.match(authorize.if, /github\.triggering_actor == github\.repository_owner/);
  assert.equal(build.needs, "authorize");
  assert.equal(build.environment, undefined);
  assert.equal(build.permissions["id-token"], undefined);
  assert.doesNotMatch(JSON.stringify(build), /secrets\./);
  assert.equal(build.steps[0].with.ref, "${{ needs.authorize.outputs.source_sha }}");
  assert.ok(
    build.steps.some((step) =>
      step.run?.includes("testDebugUnitTest lintDebug assembleDebug assembleRelease"),
    ),
  );
  assert.equal(publish.steps[0].with.ref, "${{ github.sha }}");
  assert.equal(publish.environment, "handheld-stable-publisher");
  assert.equal(publish.permissions["id-token"], "write");
  assert.deepEqual(publish.needs, ["authorize", "build"]);
  assert.match(publish.if, /github\.triggering_actor == github\.repository_owner/);
  const downloadIndex = publish.steps.findIndex((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  const download = publish.steps[downloadIndex];
  const requireArtifact = publish.steps[downloadIndex - 1];
  assert.equal(requireArtifact.env.ARTIFACT_ID, "${{ needs.build.outputs.artifact_id }}");
  assert.equal(requireArtifact.run, '[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]');
  assert.equal(download.with["artifact-ids"], "${{ needs.build.outputs.artifact_id }}");
  assert.equal(download.with["digest-mismatch"], "error");
  const checkIndex = publish.steps.findIndex((step) => step.name === "Check unsigned APK");
  const signIndex = publish.steps.findIndex((step) => step.name === "Sign and verify APK");
  const publishIndex = publish.steps.findIndex((step) => step.name === "Publish to stable");
  assert.ok(checkIndex >= 0 && checkIndex < signIndex && signIndex < publishIndex);
  assert.match(publish.steps[signIndex].run, /trap .* EXIT/);
  assert.equal(
    publish.steps[publishIndex].env.HANDHELD_SOURCE_SHA,
    "${{ needs.authorize.outputs.source_sha }}",
  );
  assert.match(publish.steps[publishIndex].run, /publish\.mjs[\s\S]*stable/);
  assert.match(verify.if, /inputs\.mode == 'verify'/u);
  assert.match(verify.if, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(verify.if, /github\.ref == 'refs\/tags\/handheld-publisher-v1'/u);
  assert.match(verify.if, /github\.actor == github\.repository_owner/u);
  assert.match(verify.if, /github\.triggering_actor == github\.repository_owner/u);
  assert.equal(verify.environment, publish.environment);
  assert.deepEqual(verify.permissions, { contents: "read", "id-token": "write" });
  assert.deepEqual(verify.steps[0].with, {
    ref: "${{ github.sha }}",
    "persist-credentials": false,
  });
  assert.doesNotMatch(JSON.stringify(verify), /secrets\.|RELEASES_S3_|KEYSTORE|upload-artifact/iu);
  assert.equal(verify.steps.at(-1).run, "node tools/release-catalog/verify-stable.mjs handheld");
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{/);
      if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
    }
  }
});
