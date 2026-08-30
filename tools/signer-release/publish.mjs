import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { buildSignerManifest } from "./manifest.mjs";
import {
  createSignerObjectStore,
  SIGNER_DOWNLOAD_KEY,
  SIGNER_MANIFEST_KEY,
  signerObjectKey,
  signerPublicUrl,
  verifyPublishedObject,
} from "./object-storage.mjs";
import { signerArtifactNames } from "./version.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Tauri names the bundle from productName and version ("Markiro Signer_0.1.0_
 * x64-setup.exe"), which is not a name to put in a URL. The exact spelling has
 * changed between Tauri releases, so the directory is searched by suffix
 * rather than by a name this file predicts.
 */
async function locateBundle(bundleDir) {
  const entries = await readdir(bundleDir);
  const installer = entries.find((name) => name.endsWith("-setup.exe"));
  if (!installer) {
    throw new Error(`no NSIS installer (*-setup.exe) in ${bundleDir}`);
  }
  const signature = `${installer}.sig`;
  if (!entries.includes(signature)) {
    throw new Error(`no detached signature ${signature} in ${bundleDir}; the build was not signed`);
  }
  return { installer, signature };
}

export async function publishSignerRelease({
  version,
  bundleDir,
  pubDate,
  store,
  fetchImpl = fetch,
}) {
  const found = await locateBundle(bundleDir);
  const names = signerArtifactNames(version);
  const installerBytes = await readFile(join(bundleDir, found.installer));
  const signatureBytes = await readFile(join(bundleDir, found.signature));
  // Tauri compares the manifest signature verbatim; the .sig file ends with a
  // newline that must not travel with it.
  const signature = signatureBytes.toString("utf8").trim();

  const installerKey = signerObjectKey({ version, filename: names.installer });
  const signatureKey = signerObjectKey({ version, filename: names.signature });
  const installerUrl = signerPublicUrl(installerKey);

  const manifest = buildSignerManifest({ version, pubDate, bundleUrl: installerUrl, signature });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await store.put(installerKey, installerBytes, "application/vnd.microsoft.portable-executable");
  await store.put(signatureKey, signatureBytes, "text/plain");
  await store.copyInstallerToDownload({
    immutableKey: installerKey,
    attachmentFilename: names.installer,
  });

  const downloadUrl = signerPublicUrl(SIGNER_DOWNLOAD_KEY);
  await verifyPublishedObject({
    url: installerUrl,
    expectedSha256: sha256(installerBytes),
    fetchImpl,
  });
  await verifyPublishedObject({
    url: downloadUrl,
    expectedSha256: sha256(installerBytes),
    fetchImpl,
  });

  // Last, deliberately: latest.json is what the agent reads, so it may not
  // name a download until both the immutable artifact and the first-install
  // alias have landed and have been read back over public HTTPS.
  await store.put(SIGNER_MANIFEST_KEY, manifestBytes, "application/json");

  const manifestUrl = signerPublicUrl(SIGNER_MANIFEST_KEY);
  await verifyPublishedObject({
    url: manifestUrl,
    expectedSha256: sha256(manifestBytes),
    fetchImpl,
  });

  return { installerUrl, manifestUrl, downloadUrl };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  const [version, bundleDir] = process.argv.slice(2);
  if (!version || !bundleDir) {
    console.error("usage: node tools/signer-release/publish.mjs <version> <bundle-dir>");
    process.exit(2);
  }
  const result = await publishSignerRelease({
    version,
    bundleDir,
    pubDate: new Date().toISOString(),
    store: createSignerObjectStore({}),
  });
  console.log(result.manifestUrl);
  console.log(result.installerUrl);
  console.log(result.downloadUrl);
}
