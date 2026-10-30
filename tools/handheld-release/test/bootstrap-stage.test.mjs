import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
const implementation = await import("../bootstrap-stage.mjs").catch(() => ({}));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const operationId = "9f7448c5-f72c-4388-8410-5c869128e04d";
const apk = Buffer.from("PK\x03\x04signed-apk");
const certificate = "27e453b2b40d3d1e4b58917acfb9c6c908036b72d6e48e3759a9e8efd5e6a3f7";
function fixture() {
  const entries = new Map(),
    objects = new Map(),
    puts = [];
  return {
    puts,
    entries,
    objects,
    journal: {
      async write(name, value) {
        assert(!entries.has(name));
        entries.set(name, value);
      },
    },
    store: {
      async exists(key) {
        return objects.has(key);
      },
      async put(key, body) {
        puts.push(key);
        objects.set(key, Buffer.from(body));
        return "original";
      },
      async read(key) {
        return { bytes: objects.get(key), versionId: "original" };
      },
    },
  };
}
function files() {
  return implementation.buildBootstrapFiles({
    apk,
    expectedSha256: sha(apk),
    sourceSha: "a".repeat(40),
    releasedAt: "2026-10-30T04:58:00Z",
    certificateOutput: `Number of signers: 1\nSigner #1 certificate SHA-256 digest: ${certificate}\n`,
    packageOutput: "package: name='app.markiro.handheld' versionCode='16' versionName='1.7.0'",
  });
}
test("APK admission requires exact installed-package identity and the existing certificate", () => {
  const valid = {
    apk,
    expectedSha256: sha(apk),
    sourceSha: "a".repeat(40),
    releasedAt: "2026-10-30T04:58:00Z",
    certificateOutput: `Number of signers: 1\nSigner #1 certificate SHA-256 digest: ${certificate}\n`,
    packageOutput: "package: name='app.markiro.handheld' versionCode='16' versionName='1.7.0'",
  };
  assert.equal(implementation.buildBootstrapFiles(valid).length, 2);
  for (const patch of [
    { expectedSha256: "b".repeat(64) },
    { certificateOutput: "Number of signers: 2\n" },
    { certificateOutput: valid.certificateOutput.replace(certificate, "f".repeat(64)) },
    { packageOutput: valid.packageOutput.replace("'16'", "'15'") },
    { packageOutput: valid.packageOutput.replace("app.markiro.handheld", "app.other") },
    { sourceSha: "main" },
  ])
    assert.throws(() => implementation.buildBootstrapFiles({ ...valid, ...patch }));
});
test("stage writes only unique import keys, verifies full version-bound bytes, and never publishes a pointer", async () => {
  const f = fixture();
  const result = await implementation.stageBootstrapFiles({ operationId, files: files(), ...f });
  assert.equal(result.objects.length, 2);
  assert(f.puts.every((key) => key.startsWith(`handheld/_catalog-imports/${operationId}/`)));
  assert(!f.puts.some((key) => /latest|download/.test(key)));
  assert.equal(result.catalogApplied, false);
  await assert.rejects(implementation.stageBootstrapFiles({ operationId, files: files(), ...f }));
  assert.equal(f.puts.length, 2);
});
test("occupied names stop before the first PUT, and ambiguous uploads are never retried", async () => {
  const occupied = fixture();
  occupied.store.exists = async () => true;
  await assert.rejects(
    implementation.stageBootstrapFiles({ operationId, files: files(), ...occupied }),
  );
  assert.equal(occupied.puts.length, 0);
  const lost = fixture();
  lost.store.put = async (key) => {
    lost.puts.push(key);
    throw Error("lost reply");
  };
  await assert.rejects(
    implementation.stageBootstrapFiles({ operationId, files: files(), ...lost }),
  );
  assert.equal(lost.puts.length, 1);
  assert(lost.entries.has("attempted-markiro-tsd-1.7.0.apk.json"));
  await assert.rejects(
    implementation.stageBootstrapFiles({ operationId, files: files(), ...lost }),
  );
  assert.equal(lost.puts.length, 1);
});
test("pinned readback corruption fails without a completion receipt", async () => {
  const f = fixture();
  f.store.read = async () => ({ bytes: Buffer.from("wrong"), versionId: "original" });
  await assert.rejects(implementation.stageBootstrapFiles({ operationId, files: files(), ...f }));
  assert(!f.entries.has("completed.json"));
});
test("only the exact successful owner-dispatched main signing run supplies the APK", () => {
  const run = {
    id: 41005803556,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: "main",
    path: ".github/workflows/handheld-release.yml",
    head_sha: "a".repeat(40),
    repository: { id: 123, owner: { id: 456 } },
    actor: { id: 456 },
  };
  const artifact = {
    id: 789,
    name: "markiro-tsd-1.7.0",
    expired: false,
    digest: "sha256:" + "b".repeat(64),
    workflow_run: { id: run.id, head_sha: run.head_sha },
  };
  assert.equal(
    implementation.validateBuildMetadata({ run, artifact }, "41005803556", "123").run.id,
    run.id,
  );
  for (const changed of [
    { ...run, head_branch: "untrusted" },
    { ...run, conclusion: "failure" },
    { ...run, run_attempt: 2 },
    { ...run, path: ".github/workflows/other.yml" },
    { ...run, actor: { id: 99 } },
  ])
    assert.throws(() =>
      implementation.validateBuildMetadata({ run: changed, artifact }, "41005803556", "123"),
    );
  for (const changed of [
    { ...artifact, expired: true },
    { ...artifact, name: "other" },
    { ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: "c".repeat(40) } },
  ])
    assert.throws(() =>
      implementation.validateBuildMetadata({ run, artifact: changed }, "41005803556", "123"),
    );
});
test("staging workflow uses existing protected credentials only after original artifact validation", async () => {
  const { readFile } = await import("node:fs/promises");
  const { load } = await import("js-yaml");
  const workflow = load(await readFile(".github/workflows/stage-handheld-catalog.yml", "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.concurrency.group, "handheld-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const job = workflow.jobs.stage;
  assert.equal(job.environment, "handheld-release");
  assert.match(job.if, /github.ref == 'refs\/heads\/main'/);
  assert.match(job.if, /github.actor == github.repository_owner/);
  assert.match(job.if, /github.run_attempt == 1/);
  const stage = job.steps.findIndex((s) => s.name?.startsWith("Stage original"));
  const extract = job.steps.findIndex((s) => s.name?.startsWith("Validate artifact archive"));
  assert(stage > extract && extract >= 0);
  for (const step of job.steps.slice(0, stage)) assert(!JSON.stringify(step).includes("secrets."));
  assert(!JSON.stringify(job).includes("MARKIRO_HANDHELD_KEYSTORE"));
  assert(!JSON.stringify(job).includes("assembleRelease"));
  assert.equal(job.steps.at(-1).if, "always()");
});
test("same-byte current-head replacement is rejected when its returned VersionId differs", async () => {
  const f = fixture();
  f.store.read = async (key) => ({
    bytes: Buffer.from(f.objects.get(key)),
    versionId: "different-head",
  });
  await assert.rejects(implementation.stageBootstrapFiles({ operationId, files: files(), ...f }));
  assert(!f.entries.has("completed.json"));
});

test("staging failure diagnostics identify the phase and child exit without private output", () => {
  const error = Object.assign(new Error("secret-key must stay private"), {
    name: "Error",
    code: "ENOENT",
    status: 7,
    stdout: "private stdout",
    stderr: "private stderr",
    spawnargs: ["private argv"],
  });
  assert.deepEqual(
    implementation.stagingFailureDiagnostic(error, {
      phase: "verify-signature",
      tool: "/private/android/apksigner",
    }),
    {
      phase: "verify-signature",
      errorName: "Error",
      code: "ENOENT",
      exitStatus: 7,
      executable: "apksigner",
    },
  );
  assert.deepEqual(
    implementation.stagingFailureDiagnostic(
      { name: "bad\nsecret", code: "secret value" },
      { phase: "startup" },
    ),
    {
      phase: "startup",
      errorName: "Error",
    },
  );
});
