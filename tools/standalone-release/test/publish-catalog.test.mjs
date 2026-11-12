import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load } from "js-yaml";
import { loadStandaloneCiArtifact, validateStandaloneCiArtifact } from "../ci-artifact.mjs";
import { NOTES_DRAFT_FILE, prepareStandaloneRelease } from "../prepare.mjs";
import {
  publishStandaloneCatalogRelease,
  verifySignedStandaloneRelease,
} from "../publish-catalog.mjs";
import { buildManifest, manifestFileName, signCompact } from "../sign-update.mjs";

const repository = "thevladbog/markiro";
const sourceSha = "a".repeat(40);
const installerBytes = Buffer.from("MZ fixture installer");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("stable workflow accepts only owner-signed public metadata on the fixed publisher tag", async () => {
  const workflow = load(await readFile(".github/workflows/standalone-stable-release.yml", "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "ci_run_id",
    "artifact_id",
    "update_jws",
  ]);
  const job = workflow.jobs.publish;
  assert.match(job.if, /github\.ref == 'refs\/tags\/standalone-publisher-v1'/u);
  assert.match(job.if, /github\.actor == github\.repository_owner/u);
  assert.match(job.if, /github\.triggering_actor == github\.repository_owner/u);
  assert.equal(job.environment, "standalone-stable-publisher");
  assert.deepEqual(job.permissions, { actions: "read", contents: "read", "id-token": "write" });
  assert.deepEqual(job.steps[0].with, { ref: "${{ github.sha }}", "persist-credentials": false });
});

function ciProof() {
  return {
    repository,
    runId: "123",
    artifactId: "456",
    run: {
      id: 123,
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "main",
      head_sha: sourceSha,
      run_attempt: 1,
      repository: { id: 12, full_name: repository },
      head_repository: { id: 12, full_name: repository },
      status: "completed",
      conclusion: "success",
    },
    jobs: [
      "ci-required",
      "standalone-windows-build",
      "standalone-windows-tests",
      "standalone-rust",
    ].map((name) => ({
      name,
      run_id: 123,
      run_attempt: 1,
      head_sha: sourceSha,
      status: "completed",
      conclusion: "success",
      started_at: "2026-11-12T07:00:00Z",
      completed_at: "2026-11-12T07:20:00Z",
    })),
    artifact: {
      id: 456,
      name: `standalone-installer-${sourceSha}`,
      size_in_bytes: 100,
      created_at: "2026-11-12T07:15:00Z",
      digest: `sha256:${"b".repeat(64)}`,
      expired: false,
      workflow_run: {
        id: 123,
        head_sha: sourceSha,
        head_branch: "main",
        head_repository_id: 12,
        repository_id: 12,
      },
    },
  };
}

test("admits only the exact installer from completed main CI with both Windows jobs successful", () => {
  assert.equal(validateStandaloneCiArtifact(ciProof()), sourceSha);
  const rerun = ciProof();
  rerun.run.path = ".github/workflows/ci.yml@refs/heads/main";
  rerun.run.run_attempt = 2;
  assert.throws(() => validateStandaloneCiArtifact(rerun), /ci-required/u);
  rerun.jobs[0].run_attempt = 2;
  assert.equal(validateStandaloneCiArtifact(rerun), sourceSha);
  for (const alter of [
    ({ run }) => (run.event = "pull_request"),
    ({ run }) => (run.head_branch = "feature"),
    ({ run }) => (run.path = ".github/workflows/other.yml"),
    ({ jobs }) => (jobs[2].conclusion = "skipped"),
    ({ jobs }) => (jobs[1].head_sha = "c".repeat(40)),
    ({ artifact }) => (artifact.workflow_run.id = 1234),
    ({ artifact }) => (artifact.workflow_run.head_sha = "c".repeat(40)),
    ({ artifact }) => (artifact.workflow_run.head_repository_id = 13),
    ({ artifact }) => (artifact.digest = null),
    ({ artifact }) => (artifact.created_at = "2026-11-12T06:15:00Z"),
  ]) {
    const proof = ciProof();
    alter(proof);
    assert.throws(() => validateStandaloneCiArtifact(proof));
  }
});

async function signedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "standalone-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleDir = join(root, "bundle");
  const version = "1.7.0";
  await mkdir(bundleDir);
  await writeFile(join(bundleDir, "test-setup.exe"), installerBytes);
  const prepared = await prepareStandaloneRelease({
    version,
    sourceRepository: repository,
    sourceSha,
    bundleDir,
    outputDir: join(root, "prepared"),
    authenticode: "NotSigned",
    protocol: 8,
    minProtocol: 1,
  });
  const kid = "test-releases";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keysetPath = join(root, "public.json");
  await writeFile(
    keysetPath,
    JSON.stringify({
      update: { keys: [{ kid, jwk: publicKey.export({ format: "jwk" }) }], retiredKids: [] },
    }),
  );
  const payload = buildManifest(prepared.draft, {
    channel: "stable",
    releasedAt: "2026-11-12T07:00:00Z",
    minUpgradeFrom: "1.1.1",
    notes: ["Исправлена печать этикеток"],
  });
  const sign = (manifest) => signCompact(privateKey, kid, manifest);
  return { prepared: { ...prepared, sourceSha, version }, keysetPath, payload, sign, root };
}

test("downloads the exact immutable CI archive and rejects extra paths and archive digest mismatches", async (t) => {
  const { prepared, root } = await signedFixture(t);
  await writeFile(join(prepared.directory, NOTES_DRAFT_FILE), "Автоматический черновик\n");
  const proof = ciProof();
  const endpoints = new Map([
    [`actions/runs/${proof.runId}`, proof.run],
    [
      `compare/${sourceSha}...main?per_page=1`,
      { status: "ahead", merge_base_commit: { sha: sourceSha } },
    ],
    [
      `actions/runs/${proof.runId}/jobs?filter=latest&per_page=100`,
      { total_count: proof.jobs.length, jobs: proof.jobs },
    ],
    [
      `actions/runs/${proof.runId}/artifacts?per_page=100`,
      { total_count: 1, artifacts: [proof.artifact] },
    ],
    [`actions/artifacts/${proof.artifactId}`, proof.artifact],
  ]);
  let archive;
  const github = {
    async json(path) {
      const value = endpoints.get(path.slice(`repos/${repository}/`.length));
      assert.ok(value, `unexpected GitHub API endpoint ${path}`);
      return value;
    },
    async archive(path) {
      assert.equal(path, `repos/${repository}/actions/artifacts/${proof.artifactId}/zip`);
      return archive;
    },
  };
  const createArchive = async (suffix) => {
    const path = join(root, `${suffix}.zip`);
    execFileSync(process.platform === "win32" ? "python" : "python3", [
      "-c",
      `
import pathlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for path in pathlib.Path(sys.argv[2]).iterdir():
        z.write(path, path.name)
    if sys.argv[3] == "extra":
        z.writestr("../unexpected", "bad")
`,
      path,
      prepared.directory,
      suffix,
    ]);
    archive = await readFile(path);
    proof.artifact.size_in_bytes = archive.length;
    proof.artifact.digest = `sha256:${sha256(archive)}`;
  };
  const input = { repository, runId: proof.runId, directory: join(root, "verified"), github };
  await createArchive("good");
  const actual = await loadStandaloneCiArtifact(input);
  assert.equal(actual.artifactId, proof.artifactId);
  assert.deepEqual(actual.draft, prepared.draft);
  assert.deepEqual(await readFile(join(actual.directory, actual.name)), installerBytes);
  await assert.rejects(
    loadStandaloneCiArtifact({ ...input, artifactId: "999" }),
    /matching installer artifact/u,
  );
  proof.artifact.digest = `sha256:${"c".repeat(64)}`;
  await assert.rejects(loadStandaloneCiArtifact(input), /SHA-256 and size/u);
  await createArchive("extra");
  await assert.rejects(
    loadStandaloneCiArtifact({ ...input, directory: join(root, "invalid") }),
    /expected regular release files/u,
  );
});

test("requires a trusted signature and exact stable CI installer, source and protocol", async (t) => {
  const { prepared, keysetPath, payload, sign } = await signedFixture(t);
  const compact = sign(payload);
  assert.deepEqual(await verifySignedStandaloneRelease(prepared, compact, keysetPath), payload);
  for (const changed of [
    { channel: "beta" },
    { sourceSha: "c".repeat(40) },
    { installer: { ...payload.installer, sha256: "c".repeat(64) } },
    { installer: { ...payload.installer, sizeBytes: payload.installer.sizeBytes + 1 } },
    { protocol: payload.protocol + 1 },
  ]) {
    await assert.rejects(
      verifySignedStandaloneRelease(prepared, sign({ ...payload, ...changed }), keysetPath),
    );
  }
  await assert.rejects(verifySignedStandaloneRelease(prepared, compact, undefined), /key/iu);
});

test("publishes only installer and signed manifest, moves stable by CAS and checks the served pointer", async (t) => {
  const { prepared, keysetPath, payload, sign, root } = await signedFixture(t);
  const compact = sign(payload);
  const scope = { product: "standalone", channel: "stable" };
  const fileName = manifestFileName(payload.version);
  const base = "https://releases.markiro.app/standalone/stable";
  const pointer = {
    v: 1,
    product: payload.product,
    channel: payload.channel,
    version: payload.version,
    releasedAt: payload.releasedAt,
    installer: {
      url: `${base}/${payload.version}/${prepared.name}`,
      sha256: sha256(installerBytes),
      sizeBytes: installerBytes.length,
    },
    manifestUrl: `${base}/${payload.version}/${fileName}`,
    notes: payload.notes,
  };
  const previous = { ...pointer, version: "1.6.1" };
  const publicationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const uploaded = [];
  const events = [];
  let latest = previous;
  let registered = null;
  let promoted = false;
  const fetchImpl = async (url) => {
    assert.equal(url, `${base}/latest.json`);
    return Response.json(latest);
  };
  const catalog = {
    async getChannel(input) {
      assert.deepEqual(input, scope);
      return {
        identity: scope,
        revision: promoted ? "8" : "7",
        readable: true,
        publicationId: promoted ? publicationId : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      };
    },
    async getPublication() {
      return registered;
    },
    async createIntent(_operationId, request) {
      assert.deepEqual(request.identity, { ...scope, version: "1.7.0" });
      assert.deepEqual(request.evidence, { kind: "standalone", manifestName: fileName });
      assert.equal(request.sourceSha, sourceSha);
      assert.deepEqual(
        request.files.map((file) => file.name),
        [prepared.name, fileName],
      );
      events.push("intent");
      return { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    },
    async uploadFile(_intent, name, bytes) {
      uploaded.push({ name, bytes });
      return { name, versionId: "object-version" };
    },
    async commitIntent(_intent, files) {
      assert.equal(files.length, 2);
      events.push("commit and immutable readback");
      registered = { publicationId };
      return registered;
    },
    async changeChannel(input, change) {
      assert.deepEqual(input, scope);
      assert.equal(change.expectedRevision, "7");
      assert.equal(change.targetPublicationId, publicationId);
      assert.equal(change.kind, "forward");
      events.push("channel");
      latest = pointer;
      promoted = true;
      return { revision: "8" };
    },
  };
  const options = {
    prepared,
    compact,
    keysetPath,
    catalog,
    fetchImpl,
    stateDirectory: join(root, "journal"),
    operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  const result = await publishStandaloneCatalogRelease(options);
  assert.deepEqual(events, ["intent", "commit and immutable readback", "channel"]);
  assert.deepEqual(
    uploaded.map(({ bytes }) => bytes),
    [installerBytes, Buffer.from(`${compact}\n`)],
  );
  assert.equal(result.manifestUrl, pointer.manifestUrl);
  assert.equal(result.installerUrl, pointer.installer.url);
  const resumed = await publishStandaloneCatalogRelease({
    ...options,
    stateDirectory: join(root, "rerun"),
  });
  assert.deepEqual(resumed, result);
  assert.equal(uploaded.length, 2);
  assert.equal(events.length, 3);
  latest = { ...pointer, notes: ["Неверный публичный манифест"] };
  await assert.rejects(
    publishStandaloneCatalogRelease({ ...options, stateDirectory: join(root, "bad-pointer") }),
    /pointer does not match/u,
  );
});
