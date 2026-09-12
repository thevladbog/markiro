import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { readNotes } from "./changelog.mjs";
import { assertSupersedes, buildHandheldManifest, handheldChannelBaseUrl } from "./manifest.mjs";
import {
  contentTypeFor,
  createHandheldObjectStore,
  handheldApkName,
  handheldManifestKey,
  handheldObjectKey,
  handheldPublicUrl,
  verifyPublishedObject,
} from "./object-storage.mjs";

async function readPublishedManifest({ store, key, fetchImpl }) {
  if ((await store.head(key)) === null) return null;
  const response = await fetchImpl(handheldPublicUrl(key), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `the published channel pointer is not readable: ${key} returned ${response.status}`,
    );
  }
  return Buffer.from(await response.arrayBuffer()).toString("utf8");
}

/**
 * Publishes one build to one channel.
 *
 * The order is the contract: the artifact and its immutable manifest are
 * written and read back first, and only then does the channel pointer move. A
 * pointer moved first sends every terminal to a 404 for as long as the upload
 * takes, and forever if the upload then fails.
 */
export async function publishHandheldRelease({
  apkPath,
  versionName,
  versionCode,
  notes,
  sourceSha,
  releasedAt = new Date().toISOString(),
  channel = "stable",
  store,
  fetchImpl = fetch,
}) {
  const apk = await readFile(apkPath);
  const sha256 = createHash("sha256").update(apk).digest("hex");
  const filename = handheldApkName(versionName);
  const apkKey = handheldObjectKey({ channel, versionName, filename });
  const immutableManifestKey = handheldObjectKey({
    channel,
    versionName,
    filename: "manifest.json",
  });
  const pointerKey = handheldManifestKey(channel);

  const manifest = buildHandheldManifest({
    versionName,
    versionCode,
    sha256,
    bytes: apk.byteLength,
    url: `${handheldChannelBaseUrl(channel)}/releases/${versionName}/${filename}`,
    notes,
    releasedAt,
    sourceSha,
    channel,
  });

  // Checked before a single byte is written: a refused release must leave the
  // channel exactly as it was.
  const published = await readPublishedManifest({ store, key: pointerKey, fetchImpl });
  assertSupersedes(published, manifest, { channel });

  const existing = await store.head(apkKey);
  if (existing !== null && existing !== sha256) {
    throw new Error(`version ${versionName} is already published with different bytes`);
  }

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");

  if (existing === null) {
    await store.putImmutable(apkKey, apk, contentTypeFor(filename), sha256);
  }
  await store.putImmutable(
    immutableManifestKey,
    manifestBytes,
    contentTypeFor("manifest.json"),
    manifestSha256,
  );

  await verifyPublishedObject({
    url: handheldPublicUrl(apkKey),
    expectedSha256: sha256,
    fetchImpl,
  });
  await verifyPublishedObject({
    url: handheldPublicUrl(immutableManifestKey),
    expectedSha256: manifestSha256,
    fetchImpl,
  });

  await store.put(pointerKey, manifestBytes, contentTypeFor("latest.json"));
  await verifyPublishedObject({
    url: handheldPublicUrl(pointerKey),
    expectedSha256: manifestSha256,
    fetchImpl,
  });

  return {
    manifest,
    apkUrl: handheldPublicUrl(apkKey),
    manifestUrl: handheldPublicUrl(pointerKey),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  const [apkPath, versionName, versionCode, channel] = process.argv.slice(2);
  const sourceSha = process.env.GITHUB_SHA;
  if (!apkPath || !versionName || !versionCode || !sourceSha) {
    console.error(
      "usage: GITHUB_SHA=… node tools/handheld-release/publish.mjs <apk> <versionName> <versionCode> [channel]",
    );
    process.exit(2);
  }
  // From the file, reviewed with the change it describes -- not from a box
  // somebody filled in while dispatching.
  const notes = await readNotes(versionName);
  const result = await publishHandheldRelease({
    apkPath,
    versionName,
    versionCode: Number(versionCode),
    notes,
    sourceSha,
    channel: channel || "stable",
    store: createHandheldObjectStore({}),
  });
  console.log(result.apkUrl);
  console.log(result.manifestUrl);
}
