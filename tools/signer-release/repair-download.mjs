import { createHash } from "node:crypto";
import process from "node:process";

import { assertValidSignerManifest } from "./manifest.mjs";
import {
  createSignerObjectStore,
  SIGNER_DOWNLOAD_KEY,
  SIGNER_MANIFEST_KEY,
  signerObjectKey,
  signerPublicUrl,
  verifyPublishedObject,
} from "./object-storage.mjs";
import { signerArtifactNames } from "./version.mjs";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;

async function readPublicBytes({ url, label, maxBytes, fetchImpl }) {
  const response = await fetchImpl(url, { cache: "no-store", redirect: "error" });
  if (!response.ok || response.redirected) {
    throw new Error(`${label} is not readable: ${url} returned ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${label} exceeds the allowed size`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`${label} exceeds the allowed size`);
  return bytes;
}

export async function repairSignerDownload({ store, fetchImpl = fetch }) {
  const manifestUrl = signerPublicUrl(SIGNER_MANIFEST_KEY);
  const manifestBytes = await readPublicBytes({
    url: manifestUrl,
    label: "current stable manifest",
    maxBytes: MAX_MANIFEST_BYTES,
    fetchImpl,
  });

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
    assertValidSignerManifest(manifest);
  } catch {
    throw new Error("current stable manifest is invalid");
  }

  const names = signerArtifactNames(manifest.version);
  const immutableKey = signerObjectKey({ version: manifest.version, filename: names.installer });
  const installerUrl = signerPublicUrl(immutableKey);
  if (manifest.platforms["windows-x86_64"].url !== installerUrl) {
    throw new Error(`current stable manifest URL does not match version ${manifest.version}`);
  }

  const installerBytes = await readPublicBytes({
    url: installerUrl,
    label: "current stable installer",
    maxBytes: MAX_INSTALLER_BYTES,
    fetchImpl,
  });
  const expectedSha256 = createHash("sha256").update(installerBytes).digest("hex");

  await store.copyInstallerToDownload({
    immutableKey,
    attachmentFilename: names.installer,
  });
  const downloadUrl = signerPublicUrl(SIGNER_DOWNLOAD_KEY);
  await verifyPublishedObject({ url: downloadUrl, expectedSha256, fetchImpl });

  return { version: manifest.version, installerUrl, downloadUrl };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  const result = await repairSignerDownload({ store: createSignerObjectStore({}) });
  console.log(result.version);
  console.log(result.installerUrl);
  console.log(result.downloadUrl);
}
