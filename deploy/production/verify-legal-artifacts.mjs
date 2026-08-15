import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { isMainModule } from "./cli-main.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_ID = "MKR-LEGAL-2026.08-01-2026-08-15";
const EXPECTED_PDFS = Object.freeze([
  "markiro_mkr-brd-01_2026.08-01_en.pdf",
  "markiro_mkr-brd-01_2026.08-01_ru.pdf",
  "markiro_mkr-dpa-01_2026.08-01_en.pdf",
  "markiro_mkr-dpa-01_2026.08-01_ru.pdf",
  "markiro_mkr-pd-01_2026.08-01_en.pdf",
  "markiro_mkr-pd-01_2026.08-01_ru.pdf",
  "markiro_mkr-pd-02_2026.08-01_en.pdf",
  "markiro_mkr-pd-02_2026.08-01_ru.pdf",
]);

function hasExactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseAttestation(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("trusted legal artifact attestation is invalid JSON");
  }
  if (
    !hasExactKeys(value, ["manifestSha256", "pdfs", "releaseId", "schemaVersion"]) ||
    value.schemaVersion !== 1 ||
    value.releaseId !== RELEASE_ID ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256.test(value.manifestSha256) ||
    !Array.isArray(value.pdfs)
  )
    throw new Error("trusted legal artifact attestation has an invalid schema");

  const names = [];
  const hashes = new Map();
  for (const pdf of value.pdfs) {
    if (
      !hasExactKeys(pdf, ["fileName", "sha256"]) ||
      typeof pdf.fileName !== "string" ||
      !EXPECTED_PDFS.includes(pdf.fileName) ||
      path.basename(pdf.fileName) !== pdf.fileName ||
      typeof pdf.sha256 !== "string" ||
      !SHA256.test(pdf.sha256) ||
      hashes.has(pdf.fileName)
    )
      throw new Error("trusted legal artifact attestation contains an invalid attested PDF");
    names.push(pdf.fileName);
    hashes.set(pdf.fileName, pdf.sha256);
  }
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_PDFS))
    throw new Error("trusted legal artifact attestation has extra, missing, or unordered PDFs");
  return { manifestSha256: value.manifestSha256, hashes };
}

function assertManifestMatchesAttestation(manifest, attestation) {
  if (!Array.isArray(manifest)) throw new Error("legal artifact manifest must be an array");
  const pdfs = manifest.filter((entry) => entry?.kind === "pdfa-2b");
  if (pdfs.length !== EXPECTED_PDFS.length)
    throw new Error("legal artifact manifest PDF inventory does not match the trusted attestation");
  const names = new Set();
  for (const pdf of pdfs) {
    if (
      typeof pdf.fileName !== "string" ||
      typeof pdf.sha256 !== "string" ||
      names.has(pdf.fileName) ||
      attestation.hashes.get(pdf.fileName) !== pdf.sha256
    )
      throw new Error("legal artifact manifest PDF does not match the trusted attestation");
    names.add(pdf.fileName);
  }
  if (EXPECTED_PDFS.some((fileName) => !names.has(fileName)))
    throw new Error("legal artifact manifest PDF inventory does not match the trusted attestation");
}

export async function verifyPublishedLegalArtifacts(
  rootArgument,
  attestationArgument,
  injectedVerifier,
) {
  if (typeof rootArgument !== "string" || rootArgument.length === 0)
    throw new Error("legal artifact root is required");
  if (typeof attestationArgument !== "string" || attestationArgument.length === 0)
    throw new Error("trusted legal artifact attestation is required");
  const rootDir = path.resolve(rootArgument);
  const manifestPath = path.join(rootDir, "artifacts.json");
  const attestationPath = path.resolve(attestationArgument);
  const attestationStats = await lstat(attestationPath);
  if (attestationStats.isSymbolicLink() || !attestationStats.isFile())
    throw new Error("trusted legal artifact attestation must be an ordinary file");
  const attestation = parseAttestation(await readFile(attestationPath, "utf8"));
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (manifestSha256 !== attestation.manifestSha256)
    throw new Error("legal artifact manifest SHA-256 does not match the trusted attestation");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("legal artifact manifest is invalid JSON");
  }
  assertManifestMatchesAttestation(manifest, attestation);
  const verifyArtifactManifest =
    injectedVerifier ??
    (await import("../../packages/legal-documents/dist/cli/verify-artifacts.js"))
      .verifyArtifactManifest;
  return verifyArtifactManifest({
    rootDir,
    manifestPath,
    pdfaValidatedFiles: new Set(attestation.hashes.keys()),
  });
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write(
      "Usage: node verify-legal-artifacts.mjs <artifact-root> <trusted-attestation>\n",
    );
    process.exitCode = 1;
  } else {
    verifyPublishedLegalArtifacts(args[0], args[1])
      .then((artifacts) => {
        process.stdout.write(`Verified ${artifacts.length} committed legal artifacts\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
