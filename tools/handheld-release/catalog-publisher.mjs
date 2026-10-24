import { publisherJournal } from "../release-catalog/journal.mjs";
import {
  releaseVersionIdSchema,
  channelSnapshotSchema,
} from "../../packages/platform-contracts/dist/release-catalog.js";
import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  buildHandheldManifest,
  assertSupersedes,
  parseHandheldManifest,
  handheldChannelBaseUrl,
} from "./manifest.mjs";
import { nextHandheldRelease } from "./version.mjs";
import {
  handheldApkName,
  handheldDownloadKey,
  handheldPublicUrl,
  contentTypeFor,
} from "./object-storage.mjs";

async function publicBytes(url, limit, fetchImpl) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(3600000),
  });
  if (response.status === 404) return null;
  if (!response.ok || !response.body) throw new Error("handheld catalog readback unavailable");
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("handheld catalog readback too large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function verifyCatalogHandheldDownload({ channel = "stable", fetchImpl = fetch }) {
  const base = handheldChannelBaseUrl(channel);
  const pointer = await publicBytes(`${base}/latest.json`, 65536, fetchImpl);
  if (!pointer) throw new Error("handheld channel is absent");
  const manifest = parseHandheldManifest(pointer.toString("utf8"), { channel });
  const immutable = await publicBytes(
    `${base}/releases/${manifest.versionName}/manifest.json`,
    65536,
    fetchImpl,
  );
  if (
    !immutable ||
    !isDeepStrictEqual(parseHandheldManifest(immutable.toString("utf8"), { channel }), manifest)
  )
    throw new Error("handheld channel and immutable manifest differ");
  const url = handheldPublicUrl(handheldDownloadKey(channel));
  const bytes = await publicBytes(url, manifest.bytes, fetchImpl);
  if (
    !bytes ||
    bytes.length !== manifest.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
  )
    throw new Error("handheld download differs from accepted manifest");
  // Re-read the pointer after the full download; a concurrent channel move is explicit, not success.
  const after = await publicBytes(`${base}/latest.json`, 65536, fetchImpl);
  if (
    !after ||
    !isDeepStrictEqual(parseHandheldManifest(after.toString("utf8"), { channel }), manifest)
  )
    throw new Error("handheld channel changed during download verification");
  return { downloadUrl: url, manifest };
}
/** Registration and full pinned readback precede CAS. Download is a projection, never a copied S3 key. */
export async function publishHandheldCatalogRelease({
  apkPath,
  versionName,
  versionCode,
  notes,
  sourceSha,
  releasedAt,
  channel = "stable",
  catalog,
  operationId,
  stateDirectory,
  emptyChannelConfirmation = "",
  fetchImpl = fetch,
}) {
  const stat = await lstat(apkPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 512 * 1024 * 1024)
    throw new Error("invalid handheld APK");
  const apk = await readFile(apkPath),
    sha256 = createHash("sha256").update(apk).digest("hex");
  if (apk.length !== stat.size || typeof releasedAt !== "string")
    throw new Error("invalid handheld publication");
  const filename = handheldApkName(versionName),
    base = handheldChannelBaseUrl(channel),
    scope = { product: "handheld", channel };
  const state = await publisherJournal(stateDirectory);
  const savedManifest = await state.read("manifest.json");
  const manifest = buildHandheldManifest({
    versionName,
    versionCode,
    sha256,
    bytes: apk.length,
    url: `${base}/releases/${versionName}/${filename}`,
    notes,
    releasedAt: savedManifest?.releasedAt ?? releasedAt,
    sourceSha,
    channel,
  });
  await state.retain("manifest.json", manifest);
  await state.retain("operation.json", { operationId, scope, emptyChannelConfirmation });
  let snapshot = await state.read("channel.json");
  if (!snapshot) {
    snapshot = await catalog.getChannel(scope);
    const before = await publicBytes(`${base}/latest.json`, 65536, fetchImpl);
    if (snapshot.revision === "0") {
      if (snapshot.publicationId !== null || before !== null)
        throw new Error("handheld empty channel not proven");
      const baseline = nextHandheldRelease({
        publishedText: null,
        bump: "minor",
        channel,
        emptyChannelConfirmation,
      });
      if (versionCode < baseline.versionCode)
        throw new Error("handheld versionCode does not upgrade distributed terminals");
    } else if (
      !snapshot.readable ||
      !snapshot.publicationId ||
      !before ||
      emptyChannelConfirmation !== ""
    )
      throw new Error("handheld channel unavailable or empty confirmation inappropriate");
    assertSupersedes(before?.toString("utf8") ?? null, manifest, { channel });
    const fresh = await catalog.getChannel(scope);
    if (
      fresh.revision !== snapshot.revision ||
      fresh.publicationId !== snapshot.publicationId ||
      fresh.readable !== snapshot.readable
    )
      throw new Error("handheld channel changed before publication");
    await state.write("channel.json", snapshot);
  }
  snapshot = channelSnapshotSchema.parse(snapshot);
  if (!isDeepStrictEqual(snapshot.identity, scope))
    throw new Error("handheld journal scope mismatch");
  const bodies = [
    { name: filename, body: apk },
    { name: "manifest.json", body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
  ];
  const intent = await catalog.createIntent(operationId, {
    identity: { ...scope, version: versionName },
    sourceSha,
    files: bodies.map(({ name, body }) => ({
      name,
      sizeBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      contentType: contentTypeFor(name),
    })),
    evidence: { kind: "handheld", manifestName: "manifest.json", versionCode },
  });
  const files = [];
  for (const { name, body } of bodies) {
    const receipt = await state.read(`uploaded-${name}.json`);
    if (receipt) {
      if (receipt.intentId !== intent.id || receipt.file.name !== name)
        throw new Error("handheld journal mismatch");
      releaseVersionIdSchema.parse(receipt.file.versionId);
      files.push(receipt.file);
      continue;
    }
    if (await state.read(`attempted-${name}.json`))
      throw new Error("ambiguous handheld upload; reconcile before retry");
    await state.write(`attempted-${name}.json`, { intentId: intent.id, name });
    const file = await catalog.uploadFile(intent, name, body);
    await state.write(`uploaded-${name}.json`, { intentId: intent.id, file });
    files.push(file);
  }
  const result = await catalog.commitIntent(intent, files);
  // Distinct operation namespace from the publication receipt, stable on a retry.
  const channelOperation = createHash("sha256")
    .update(`handheld-channel:${operationId}`)
    .digest("hex");
  const channelId = `${channelOperation.slice(0, 8)}-${channelOperation.slice(8, 12)}-4${channelOperation.slice(13, 16)}-8${channelOperation.slice(17, 20)}-${channelOperation.slice(20, 32)}`;
  const change = {
    operationId: channelId,
    expectedRevision: snapshot.revision,
    targetPublicationId: result.publicationId,
    kind: "forward",
  };
  await state.retain("channel-attempt.json", change);
  const changed = await catalog.changeChannel(scope, change);
  await state.retain("channel-accepted.json", changed);
  const verified = await verifyCatalogHandheldDownload({ channel, fetchImpl });
  if (!isDeepStrictEqual(verified.manifest, manifest))
    throw new Error("handheld published channel differs from committed release");
  return {
    manifest,
    downloadUrl: verified.downloadUrl,
    apkUrl: manifest.url,
    manifestUrl: `${base}/latest.json`,
  };
}
