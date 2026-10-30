import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { basename } from "node:path";
import { publisherJournal } from "../release-catalog/journal.mjs";
import { buildHandheldManifest } from "./manifest.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const certificate = "27e453b2b40d3d1e4b58917acfb9c6c908036b72d6e48e3759a9e8efd5e6a3f7";
/** Download provenance is checked independently of the mutable current main. */
export function validateBuildMetadata(proof, runId, repositoryId) {
  assert.match(runId, /^[1-9][0-9]*$/u);
  assert.match(repositoryId, /^[1-9][0-9]*$/u);
  const { run, artifact } = proof;
  assert.equal(String(run.id), runId);
  assert.equal(String(run.repository.id), repositoryId);
  assert.equal(run.actor.id, run.repository.owner.id);
  assert.equal(run.run_attempt, 1);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.head_branch, "main");
  assert.equal(run.path, ".github/workflows/handheld-release.yml");
  assert.match(run.head_sha, /^[a-f0-9]{40}$/u);
  assert.equal(artifact.workflow_run.id, run.id);
  assert.equal(artifact.workflow_run.head_sha, run.head_sha);
  assert.equal(artifact.name, "markiro-tsd-1.7.0");
  assert.equal(artifact.expired, false);
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/u);
  return proof;
}
/** Fixed initial 1.7.0 import; no generic version, certificate or namespace override. */
export function buildBootstrapFiles({
  apk,
  expectedSha256,
  sourceSha,
  releasedAt,
  certificateOutput,
  packageOutput,
}) {
  assert(Buffer.isBuffer(apk) && apk.length > 4 && apk.length <= 536870912);
  assert.equal(apk.subarray(0, 4).toString("hex"), "504b0304");
  assert.match(expectedSha256, /^[a-f0-9]{64}$/u);
  assert.equal(hash(apk), expectedSha256);
  assert.match(sourceSha, /^[a-f0-9]{40}$/u);
  assert.match(certificateOutput, /(?:^|\n)Number of signers: 1(?:\r?\n|$)/u);
  const certificates = [
    ...certificateOutput.matchAll(/Signer #[0-9]+ certificate SHA-256 digest: ([a-f0-9]{64})/gu),
  ];
  assert.equal(certificates.length, 1);
  assert.equal(certificates[0][1], certificate);
  assert.match(
    packageOutput,
    /(?:^|\n)package: name='app\.markiro\.handheld' versionCode='16' versionName='1\.7\.0'(?: |\r?\n|$)/u,
  );
  const manifest = buildHandheldManifest({
    versionName: "1.7.0",
    versionCode: 16,
    sha256: expectedSha256,
    bytes: apk.length,
    sourceSha,
    releasedAt,
    notes: "ТСД 1.7.0: обновление после 1.6.1 (15).",
    channel: "stable",
    url: "https://releases.markiro.app/handheld/stable/releases/1.7.0/markiro-tsd-1.7.0.apk",
  });
  return [
    {
      name: "markiro-tsd-1.7.0.apk",
      body: apk,
      contentType: "application/vnd.android.package-archive",
    },
    {
      name: "manifest.json",
      body: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
      contentType: "application/json",
    },
  ];
}
/** Durable one-shot staging only. Ambiguous writes require reconciliation of this same operation. */
export async function stageBootstrapFiles({ operationId, files, store, journal }) {
  assert.match(
    operationId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((f) => f.name),
    ["markiro-tsd-1.7.0.apk", "manifest.json"],
  );
  const prefix = `handheld/_catalog-imports/${operationId}/`;
  const specs = files.map(({ name, body, contentType }) => ({
    name,
    key: prefix + name,
    sha256: hash(body),
    sizeBytes: body.length,
    contentType,
  }));
  await journal.write("intent.json", { operationId, files: specs });
  for (const spec of specs) assert.equal(await store.exists(spec.key), false);
  const objects = [];
  for (const [i, spec] of specs.entries()) {
    await journal.write(`attempted-${spec.name}.json`, spec);
    const versionId = await store.put(spec.key, files[i].body, spec.contentType);
    assert(
      typeof versionId === "string" &&
        versionId.length > 0 &&
        versionId.length <= 1024 &&
        versionId.trim() === versionId &&
        versionId !== "null" &&
        !/[\p{Cc}]/u.test(versionId),
    );
    const object = { ...spec, versionId };
    await journal.write(`stored-${spec.name}.json`, object);
    const readback = await store.read(spec.key, spec.sizeBytes);
    // The uploader has GetObject, not GetObjectVersion. Reject any concurrent
    // head replacement; the catalog reader separately probes the pinned version.
    assert.equal(readback.versionId, versionId);
    assert.equal(readback.bytes.length, spec.sizeBytes);
    assert.equal(hash(readback.bytes), spec.sha256);
    objects.push(object);
  }
  const result = {
    operationId,
    objects,
    fullVersionBoundReadback: true,
    readbackMode: "current-response-version-must-match-upload",
    catalogApplied: false,
    publicPointerChanged: false,
  };
  await journal.write("completed.json", result);
  return result;
}
export function stagingFailureDiagnostic(error, { phase, tool } = {}) {
  const problem = { phase, errorName: "Error" };
  if (/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error?.name ?? "")) problem.errorName = error.name;
  if (/^(?:ERR_[A-Z0-9_]{1,55}|E[A-Z0-9_]{1,55})$/u.test(error?.code ?? ""))
    problem.code = error.code;
  if (Number.isInteger(error?.status)) problem.exitStatus = error.status;
  if (typeof tool === "string" && /^[A-Za-z0-9_.-]+$/u.test(basename(tool)))
    problem.executable = basename(tool);
  return problem;
}
let failureContext = { phase: "startup" };
async function main() {
  const [apkPath, proofPath, journalPath] = process.argv.slice(2);
  assert.equal(process.argv.length, 5);
  failureContext = { phase: "validate-source" };
  const proof = validateBuildMetadata(
    JSON.parse(await readFile(proofPath, "utf8")),
    process.env.SOURCE_RUN_ID,
    process.env.GITHUB_REPOSITORY_ID,
  ).run;
  failureContext = { phase: "read-apk" };
  const apk = await readFile(apkPath);
  const run = (tool, args, phase) => {
    failureContext = { phase, tool };
    return execFileSync(tool, args, {
      encoding: "utf8",
      maxBuffer: 131072,
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const certificateOutput = run(
    process.env.APKSIGNER,
    ["verify", "--verbose", "--print-certs", apkPath],
    "verify-signature",
  );
  const packageOutput = run(process.env.AAPT, ["dump", "badging", apkPath], "inspect-package");
  failureContext = { phase: "validate-apk" };
  const files = buildBootstrapFiles({
    apk,
    expectedSha256: process.env.APK_SHA256,
    sourceSha: proof.head_sha,
    releasedAt: proof.created_at,
    certificateOutput,
    packageOutput,
  });
  failureContext = { phase: "storage-configuration" };
  assert.equal(process.env.RELEASES_S3_BUCKET, "markiro-releases");
  assert(process.env.RELEASES_S3_ACCESS_KEY_ID && process.env.RELEASES_S3_SECRET_ACCESS_KEY);
  const { S3Client, HeadObjectCommand, PutObjectCommand, GetObjectCommand } =
    await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: "https://s3.twcstorage.ru",
    region: "ru-1",
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: process.env.RELEASES_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.RELEASES_S3_SECRET_ACCESS_KEY,
    },
  });
  const send = (command) => client.send(command, { abortSignal: AbortSignal.timeout(600000) });
  const bucket = "markiro-releases";
  try {
    const store = {
      async exists(Key) {
        try {
          await send(new HeadObjectCommand({ Bucket: bucket, Key }));
          return true;
        } catch (e) {
          if (e.$metadata?.httpStatusCode === 404) return false;
          throw e;
        }
      },
      async put(Key, Body, ContentType) {
        const result = await send(
          new PutObjectCommand({
            Bucket: bucket,
            Key,
            Body,
            ContentType,
            ContentMD5: createHash("md5").update(Body).digest("base64"),
            CacheControl: "private, no-store",
            IfNoneMatch: "*",
          }),
        );
        return result.VersionId;
      },
      async read(Key, expectedSize) {
        const response = await send(new GetObjectCommand({ Bucket: bucket, Key }));
        assert.equal(response.ContentLength, expectedSize);
        const chunks = [];
        let size = 0;
        for await (const chunk of response.Body) {
          size += chunk.length;
          if (size > expectedSize) {
            response.Body.destroy();
            throw Error("Pinned object too large");
          }
          chunks.push(chunk);
        }
        return { bytes: Buffer.concat(chunks, size), versionId: response.VersionId };
      },
    };
    failureContext = { phase: "create-journal" };
    const journal = await publisherJournal(journalPath);
    await journal.write("source.json", {
      runId: String(proof.id),
      sourceSha: proof.head_sha,
      artifactSha256: process.env.APK_SHA256,
      package: "app.markiro.handheld",
      versionName: "1.7.0",
      versionCode: 16,
      certificateSha256: certificate,
    });
    await journal.write("manifest.json", JSON.parse(files[1].body.toString("utf8")));
    failureContext = { phase: "stage-objects" };
    await stageBootstrapFiles({
      operationId: process.env.CATALOG_OPERATION_ID,
      files,
      store,
      journal,
    });
    console.log(
      "Signed handheld 1.7.0 staged with version-bound full readback; catalog unchanged.",
    );
  } finally {
    client.destroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify(stagingFailureDiagnostic(error, failureContext)));
    console.error("Handheld staging failed; preserve receipts and reconcile before any retry.");
    process.exitCode = 1;
  });
}
