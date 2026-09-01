import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  createSignerObjectStore,
  SIGNER_DOWNLOAD_KEY,
  SIGNER_MANIFEST_KEY,
  signerObjectKey,
  signerPublicUrl,
  verifyPublishedObject,
} from "./object-storage.mjs";
import { verifyPreparedSignerRelease } from "./prepare.mjs";

const contentType = (name) => {
  if (name.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  if (name.endsWith(".json")) return "application/json";
  return "text/plain";
};

export async function publishPreparedSignerRelease({
  version,
  releaseDir,
  store,
  fetchImpl = fetch,
}) {
  const prepared = await verifyPreparedSignerRelease({ directory: releaseDir, version });
  const immutableNames = [
    prepared.names.installer,
    prepared.names.signature,
    "latest.json",
    "SHA256SUMS",
    "release-evidence.json",
  ];

  for (const name of immutableNames) {
    const key = signerObjectKey({ version, filename: name });
    const bytes = await readFile(prepared.paths[name]);
    const expectedSha256 = prepared.hashes[name];
    const existingSha256 = await store.head(key);
    if (existingSha256 === null) {
      await store.putImmutable(key, bytes, contentType(name), expectedSha256);
    } else if (existingSha256 !== expectedSha256) {
      throw new Error(`immutable signer object differs: ${key}`);
    }
  }

  for (const name of immutableNames) {
    const key = signerObjectKey({ version, filename: name });
    await verifyPublishedObject({
      url: signerPublicUrl(key),
      expectedSha256: prepared.hashes[name],
      fetchImpl,
    });
  }

  const installerKey = signerObjectKey({
    version,
    filename: prepared.names.installer,
  });
  await store.copyInstallerToDownload({
    immutableKey: installerKey,
    attachmentFilename: prepared.names.installer,
  });
  const downloadUrl = signerPublicUrl(SIGNER_DOWNLOAD_KEY);
  await verifyPublishedObject({
    url: downloadUrl,
    expectedSha256: prepared.hashes[prepared.names.installer],
    fetchImpl,
  });

  const manifestBytes = await readFile(prepared.paths["latest.json"]);
  await store.put(SIGNER_MANIFEST_KEY, manifestBytes, "application/json");
  const manifestUrl = signerPublicUrl(SIGNER_MANIFEST_KEY);
  await verifyPublishedObject({
    url: manifestUrl,
    expectedSha256: prepared.hashes["latest.json"],
    fetchImpl,
  });

  return {
    installerUrl: signerPublicUrl(installerKey),
    manifestUrl,
    downloadUrl,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  const [version, releaseDir] = process.argv.slice(2);
  if (!version || !releaseDir) {
    console.error("usage: node tools/signer-release/publish.mjs <version> <prepared-release-dir>");
    process.exit(2);
  }
  const result = await publishPreparedSignerRelease({
    version,
    releaseDir,
    store: createSignerObjectStore({}),
  });
  console.log(result.manifestUrl);
  console.log(result.installerUrl);
  console.log(result.downloadUrl);
}
