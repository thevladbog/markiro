import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareSignerRelease } from "../prepare.mjs";
import { publishPreparedSignerRelease } from "../publish.mjs";
import { signerArtifactNames } from "../version.mjs";

const VERSION = "0.1.5";
const SOURCE_SHA = "b".repeat(40);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function preparedDir() {
  const root = await mkdtemp(join(tmpdir(), "signer-publish-"));
  const bundleDir = join(root, "bundle");
  const releaseDir = join(root, "release");
  await mkdir(bundleDir);
  await writeFile(join(bundleDir, "Markiro Signer_0.1.5_x64-setup.exe"), "signed installer");
  await writeFile(join(bundleDir, "Markiro Signer_0.1.5_x64-setup.exe.sig"), "signature\n");
  await prepareSignerRelease({
    version: VERSION,
    sourceRepository: "thevladbog/markiro",
    sourceSha: SOURCE_SHA,
    bundleDir,
    outputDir: releaseDir,
    pubDate: "2026-09-01T12:00:00.000Z",
  });
  return releaseDir;
}

function fakeMirror() {
  const objects = new Map();
  const operations = [];
  const store = {
    head: async (key) => objects.get(key)?.sha256 ?? null,
    putImmutable: async (key, body, _contentType, expectedSha256) => {
      const bytes = Buffer.from(body);
      operations.push(`put-immutable:${key}`);
      objects.set(key, { bytes, sha256: expectedSha256 });
    },
    put: async (key, body) => {
      const bytes = Buffer.from(body);
      operations.push(`put:${key}`);
      objects.set(key, { bytes, sha256: sha256(bytes) });
    },
    copyInstallerToDownload: async ({ immutableKey }) => {
      operations.push(`copy:${immutableKey}`);
      objects.set("signer/download", objects.get(immutableKey));
    },
  };
  const fetchImpl = async (url) => {
    const object = objects.get(new URL(url).pathname.slice(1));
    return object
      ? new Response(object.bytes, { status: 200 })
      : new Response("", { status: 404 });
  };
  return { objects, operations, store, fetchImpl };
}

test("publishes every prepared asset before advancing mutable pointers", async () => {
  const mirror = fakeMirror();
  const result = await publishPreparedSignerRelease({
    version: VERSION,
    releaseDir: await preparedDir(),
    store: mirror.store,
    fetchImpl: mirror.fetchImpl,
  });

  const names = signerArtifactNames(VERSION);
  const immutable = [
    names.installer,
    names.signature,
    "latest.json",
    "SHA256SUMS",
    "release-evidence.json",
  ].map((name) => `signer/stable/releases/${VERSION}/${name}`);
  for (const key of immutable) assert.equal(mirror.objects.has(key), true, key);
  assert.equal(mirror.objects.has("signer/download"), true);
  assert.equal(mirror.objects.has("signer/stable/latest.json"), true);

  const firstMutable = mirror.operations.findIndex(
    (entry) => entry.startsWith("copy:") || entry === "put:signer/stable/latest.json",
  );
  assert.equal(firstMutable, immutable.length);
  assert.equal(mirror.operations.at(-1), "put:signer/stable/latest.json");
  assert.equal(result.downloadUrl, "https://releases.markiro.app/signer/download");
});

test("reuses an identical immutable object without rewriting it", async () => {
  const releaseDir = await preparedDir();
  const mirror = fakeMirror();
  const names = signerArtifactNames(VERSION);
  const installerBytes = await readFile(join(releaseDir, names.installer));
  const installerKey = `signer/stable/releases/${VERSION}/${names.installer}`;
  mirror.objects.set(installerKey, { bytes: installerBytes, sha256: sha256(installerBytes) });

  await publishPreparedSignerRelease({
    version: VERSION,
    releaseDir,
    store: mirror.store,
    fetchImpl: mirror.fetchImpl,
  });

  assert.equal(mirror.operations.includes(`put-immutable:${installerKey}`), false);
});

test("refuses different immutable bytes before changing either pointer", async () => {
  const releaseDir = await preparedDir();
  const mirror = fakeMirror();
  const names = signerArtifactNames(VERSION);
  const installerKey = `signer/stable/releases/${VERSION}/${names.installer}`;
  mirror.objects.set(installerKey, {
    bytes: Buffer.from("old bytes"),
    sha256: sha256(Buffer.from("old bytes")),
  });

  await assert.rejects(
    publishPreparedSignerRelease({
      version: VERSION,
      releaseDir,
      store: mirror.store,
      fetchImpl: mirror.fetchImpl,
    }),
    /immutable signer object differs/,
  );
  assert.equal(mirror.objects.has("signer/download"), false);
  assert.equal(mirror.objects.has("signer/stable/latest.json"), false);
});

test("does not advance pointers when public immutable verification fails", async () => {
  const mirror = fakeMirror();
  const fetchImpl = async (url) => {
    if (new URL(url).pathname.endsWith("-setup.exe")) {
      return new Response("truncated", { status: 200 });
    }
    return mirror.fetchImpl(url);
  };

  await assert.rejects(
    publishPreparedSignerRelease({
      version: VERSION,
      releaseDir: await preparedDir(),
      store: mirror.store,
      fetchImpl,
    }),
    /does not match/,
  );
  assert.equal(mirror.objects.has("signer/download"), false);
  assert.equal(mirror.objects.has("signer/stable/latest.json"), false);
});
