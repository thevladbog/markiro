import { createHash } from "node:crypto";

import { assertValidHandheldManifest, parseHandheldManifest } from "./manifest.mjs";
import {
  createHandheldObjectStore,
  handheldDownloadKey,
  handheldManifestKey,
  handheldObjectKey,
  handheldPublicUrl,
  verifyPublishedObject,
} from "./object-storage.mjs";

export async function publishHandheldDownload({ manifest, channel, store, fetchImpl = fetch }) {
  assertValidHandheldManifest(manifest, { channel });
  await store.copyDownload({ channel, versionName: manifest.versionName });
  const url = handheldPublicUrl(handheldDownloadKey(channel));
  await verifyPublishedObject({ url, expectedSha256: manifest.sha256, fetchImpl });
  return url;
}

/** Repairs or creates only the download link from the existing, verified channel. */
export async function syncHandheldDownload({ channel = "stable", store, fetchImpl = fetch }) {
  async function read(url) {
    const response = await fetchImpl(url, { cache: "no-store", redirect: "error" });
    if (!response.ok)
      throw new Error(`published object is not readable: ${url} (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  const pointerKey = handheldManifestKey(channel);
  const pointer = await read(handheldPublicUrl(pointerKey));
  const manifest = parseHandheldManifest(pointer.toString("utf8"), { channel });
  const immutable = await read(
    handheldPublicUrl(
      handheldObjectKey({
        channel,
        versionName: manifest.versionName,
        filename: "manifest.json",
      }),
    ),
  );
  if (!pointer.equals(immutable)) throw new Error("channel and immutable handheld manifest differ");
  const apk = await read(manifest.url);
  if (
    apk.length !== manifest.bytes ||
    createHash("sha256").update(apk).digest("hex") !== manifest.sha256
  ) {
    throw new Error("published handheld APK does not match its manifest");
  }
  // The CDN can serve an older channel. Refuse to move the link backwards even
  // then; workflow concurrency serializes this operation with normal releases.
  if ((await store.head(pointerKey)) !== createHash("sha256").update(pointer).digest("hex")) {
    throw new Error("handheld channel changed or public channel is stale");
  }
  return publishHandheldDownload({ manifest, channel, store, fetchImpl });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  const url = await syncHandheldDownload({
    channel: process.env.CHANNEL || "stable",
    store: createHandheldObjectStore({}),
  });
  console.log(url);
}
