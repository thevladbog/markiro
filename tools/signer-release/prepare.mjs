import { validateSignerReleaseFiles } from "./artifacts.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildSignerManifest } from "./manifest.mjs";
import { signerObjectKey, signerPublicUrl } from "./object-storage.mjs";
import { signerArtifactNames } from "./version.mjs";

const EVIDENCE_FILE = "release-evidence.json";
const MANIFEST_FILE = "latest.json";
const CHECKSUM_FILE = "SHA256SUMS";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateSource(sourceRepository, sourceSha) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository ?? "")) {
    throw new Error("source repository is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "")) {
    throw new Error("source SHA must be a full lowercase Git commit SHA");
  }
}

async function locateBundle(bundleDir) {
  const entries = await readdir(bundleDir);
  const installers = entries.filter((name) => name.endsWith("-setup.exe"));
  if (installers.length !== 1) {
    throw new Error(`expected exactly one NSIS installer in ${bundleDir}`);
  }
  const installer = installers[0];
  const signature = `${installer}.sig`;
  if (!entries.includes(signature)) {
    throw new Error(`no detached signature ${signature} in ${bundleDir}`);
  }
  return { installer, signature };
}

export async function prepareSignerRelease({
  version,
  sourceRepository,
  sourceSha,
  bundleDir,
  outputDir,
  pubDate,
}) {
  validateSource(sourceRepository, sourceSha);
  const found = await locateBundle(bundleDir);
  await mkdir(outputDir, { recursive: true });
  if ((await readdir(outputDir)).length !== 0) {
    throw new Error(`prepared release directory is not empty: ${outputDir}`);
  }

  const names = signerArtifactNames(version);
  const installerBytes = await readFile(join(bundleDir, found.installer));
  const signatureBytes = await readFile(join(bundleDir, found.signature));
  const signature = signatureBytes.toString("utf8").trim();
  const installerUrl = signerPublicUrl(signerObjectKey({ version, filename: names.installer }));
  const manifest = buildSignerManifest({
    version,
    pubDate,
    bundleUrl: installerUrl,
    signature,
  });
  const manifestBytes = jsonBytes(manifest);

  await writeFile(join(outputDir, names.installer), installerBytes);
  await writeFile(join(outputDir, names.signature), signatureBytes);
  await writeFile(join(outputDir, MANIFEST_FILE), manifestBytes);

  const primaryAssets = {
    [names.installer]: { sha256: sha256(installerBytes), size: installerBytes.length },
    [names.signature]: { sha256: sha256(signatureBytes), size: signatureBytes.length },
    [MANIFEST_FILE]: { sha256: sha256(manifestBytes), size: manifestBytes.length },
  };
  const evidence = {
    schemaVersion: 1,
    product: "signer",
    channel: "stable",
    version,
    pubDate,
    source: { repository: sourceRepository, sha: sourceSha },
    assets: primaryAssets,
  };
  const evidenceBytes = jsonBytes(evidence);
  await writeFile(join(outputDir, EVIDENCE_FILE), evidenceBytes);

  const hashes = {
    [names.installer]: primaryAssets[names.installer].sha256,
    [names.signature]: primaryAssets[names.signature].sha256,
    [MANIFEST_FILE]: primaryAssets[MANIFEST_FILE].sha256,
    [EVIDENCE_FILE]: sha256(evidenceBytes),
  };
  const sums = Object.entries(hashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, hash]) => `${hash}  ${name}`)
    .join("\n");
  await writeFile(join(outputDir, CHECKSUM_FILE), `${sums}\n`, "utf8");

  return verifyPreparedSignerRelease({ directory: outputDir, version });
}

export async function verifyPreparedSignerRelease({ directory, version }) {
  const entries = (await readdir(directory)).sort();
  const bytes = Object.fromEntries(
    await Promise.all(entries.map(async (name) => [name, await readFile(join(directory, name))])),
  );
  const result = await validateSignerReleaseFiles(
    {
      names: entries,
      size: (name) => bytes[name].length,
      digest: async (name) => sha256(bytes[name]),
      text: async (name, maximum) => {
        if (bytes[name].length > maximum) throw new Error("signer text exceeds limit");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes[name]);
      },
    },
    { version },
  );
  return {
    ...result,
    directory,
    paths: Object.fromEntries(entries.map((name) => [name, join(directory, name)])),
  };
}
