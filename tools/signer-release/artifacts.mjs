import { assertValidSignerManifest } from "./manifest.mjs";
import { signerArtifactNames } from "./version.mjs";
const EVIDENCE_FILE = "release-evidence.json",
  MANIFEST_FILE = "latest.json",
  CHECKSUM_FILE = "SHA256SUMS";
function validateSource(sourceRepository, sourceSha) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository ?? "")) {
    throw new Error("source repository is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "")) {
    throw new Error("source SHA must be a full lowercase Git commit SHA");
  }
}

function expectedNames(version) {
  const names = signerArtifactNames(version);
  return [CHECKSUM_FILE, EVIDENCE_FILE, MANIFEST_FILE, names.installer, names.signature].sort();
}

export async function validateSignerReleaseFiles(reader, { version }) {
  const names = signerArtifactNames(version);
  const entries = [...reader.names].sort();
  if (entries.join("\n") !== expectedNames(version).join("\n")) {
    throw new Error("prepared signer release has an unexpected asset set");
  }

  const manifest = JSON.parse(await reader.text(MANIFEST_FILE, 65536));
  assertValidSignerManifest(manifest);
  const expectedUrl = `https://releases.markiro.app/signer/stable/releases/${version}/${names.installer}`;
  if (
    manifest.version !== version ||
    manifest.platforms["windows-x86_64"].url !== expectedUrl ||
    manifest.platforms["windows-x86_64"].signature !==
      (await reader.text(names.signature, 16384)).trim()
  ) {
    throw new Error("prepared signer manifest does not match its release assets");
  }

  const evidence = JSON.parse(await reader.text(EVIDENCE_FILE, 65536));
  if (
    evidence?.schemaVersion !== 1 ||
    evidence?.product !== "signer" ||
    evidence?.channel !== "stable" ||
    evidence?.version !== version
  ) {
    throw new Error("prepared signer release evidence is invalid");
  }
  validateSource(evidence.source?.repository, evidence.source?.sha);

  const primaryNames = [names.installer, names.signature, MANIFEST_FILE].sort();
  if (
    Object.keys(evidence.assets ?? {})
      .sort()
      .join("\n") !== primaryNames.join("\n")
  ) {
    throw new Error("prepared signer release evidence names unexpected assets");
  }
  for (const name of primaryNames) {
    const actualHash = await reader.digest(name);
    if (
      evidence.assets[name]?.sha256 !== actualHash ||
      evidence.assets[name]?.size !== reader.size(name)
    ) {
      throw new Error(`prepared signer release checksum mismatch: ${name}`);
    }
  }

  const checksumLines = (await reader.text(CHECKSUM_FILE, 65536)).trim().split("\n");
  const checksumEntries = new Map();
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(line);
    if (!match || checksumEntries.has(match[2])) {
      throw new Error("prepared signer SHA256SUMS is invalid");
    }
    checksumEntries.set(match[2], match[1]);
  }
  const hashedNames = [names.installer, names.signature, MANIFEST_FILE, EVIDENCE_FILE].sort();
  if ([...checksumEntries.keys()].sort().join("\n") !== hashedNames.join("\n")) {
    throw new Error("prepared signer SHA256SUMS names unexpected assets");
  }
  const hashes = {};
  for (const name of hashedNames) {
    const actualHash = await reader.digest(name);
    if (checksumEntries.get(name) !== actualHash) {
      throw new Error(`prepared signer release checksum mismatch: ${name}`);
    }
    hashes[name] = actualHash;
  }
  hashes[CHECKSUM_FILE] = await reader.digest(CHECKSUM_FILE);

  return {
    names,
    hashes,
    manifest,
    evidence,
  };
}

export { signerArtifactNames };
