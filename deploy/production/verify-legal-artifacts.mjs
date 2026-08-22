import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "./cli-main.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const execFile = promisify(execFileCallback);
const RELEASE_ID = "MKR-LEGAL-2026.08-03-2026-08-22";
const EXPECTED_PDFS = Object.freeze([
  "markiro_mkr-brd-01_2026.08-01_en.pdf",
  "markiro_mkr-brd-01_2026.08-01_ru.pdf",
  "markiro_mkr-dpa-01_2026.08-01_en.pdf",
  "markiro_mkr-dpa-01_2026.08-01_ru.pdf",
  "markiro_mkr-ins-01_2026.08-01_ru.pdf",
  "markiro_mkr-ins-02_2026.08-01_ru.pdf",
  "markiro_mkr-ins-03_2026.08-01_ru.pdf",
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

async function runFreshVeraPdf(binary, args, execute) {
  try {
    return await execute(binary, args, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (cause) {
    throw new Error("fresh pinned veraPDF validation failed", { cause });
  }
}

export function createFreshPdfAValidator({
  execute = execFile,
  parseVeraPdfValidationResult,
  image,
  version,
}) {
  const runtime = process.env.VERAPDF_CONTAINER_RUNTIME;
  const binary = process.env.VERAPDF_BIN;
  const hasRuntime = typeof runtime === "string" && runtime.length > 0;
  const hasBinary = typeof binary === "string" && binary.length > 0;
  if (
    hasRuntime === hasBinary ||
    (hasRuntime && runtime !== "docker" && runtime !== "podman") ||
    (hasBinary && binary !== "/opt/verapdf/verapdf")
  ) {
    throw new Error("fresh pinned veraPDF validator configuration is invalid");
  }

  const command = hasRuntime ? runtime : binary;
  let versionCheck;
  const ensureVersion = async () => {
    versionCheck ??= (async () => {
      const args = hasRuntime
        ? ["run", "--rm", "--network", "none", image, "--version"]
        : ["--version"];
      const result = await runFreshVeraPdf(command, args, execute);
      const exactVersion = new RegExp(`(?:^|\\D)${version.replaceAll(".", "\\.")}(?:\\D|$)`);
      if (!exactVersion.test(result.stdout)) {
        throw new Error("fresh pinned veraPDF validation failed");
      }
    })();
    return versionCheck;
  };

  return async (pdfPath) => {
    await ensureVersion();
    const args = hasRuntime
      ? [
          "run",
          "--rm",
          "--network",
          "none",
          "--volume",
          `${path.dirname(pdfPath)}:/data:ro`,
          image,
          "--format",
          "json",
          "--flavour",
          "2b",
          `/data/${path.basename(pdfPath)}`,
        ]
      : ["--format", "json", "--flavour", "2b", pdfPath];
    const result = await runFreshVeraPdf(command, args, execute);
    try {
      parseVeraPdfValidationResult(result.stdout);
    } catch {
      throw new Error("fresh pinned veraPDF validation failed");
    }
  };
}

async function readTrustedPdf(filePath) {
  let handle;
  try {
    const initialStats = await lstat(filePath);
    if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
      throw new Error("not ordinary");
    }
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw new Error("not ordinary");
    return await handle.readFile();
  } catch {
    throw new Error("trusted legal PDF must be a readable ordinary file");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function collectFreshPdfAEvidence(rootDir, attestation, validatePdf) {
  let temporaryRoot;
  try {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "markiro-legal-pdfa-"));
    const validated = new Set();
    for (const [index, fileName] of EXPECTED_PDFS.entries()) {
      const bytes = await readTrustedPdf(path.join(rootDir, "files", fileName));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== attestation.hashes.get(fileName)) {
        throw new Error("trusted legal PDF changed before fresh validation");
      }
      const privatePath = path.join(temporaryRoot, `document-${index}.pdf`);
      try {
        await writeFile(privatePath, bytes, { flag: "wx", mode: 0o600 });
      } catch {
        throw new Error("fresh pinned veraPDF validation failed");
      }
      await validatePdf(privatePath);
      validated.add(fileName);
    }
    return validated;
  } finally {
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function verifyPublishedLegalArtifacts(
  rootArgument,
  attestationArgument,
  injectedVerifier,
  injectedPdfAValidator,
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
  const legalVerifierModule =
    injectedVerifier && injectedPdfAValidator
      ? undefined
      : await import("../../packages/legal-documents/dist/cli/verify-artifacts.js");
  const validatePdf =
    injectedPdfAValidator ??
    createFreshPdfAValidator({
      parseVeraPdfValidationResult: legalVerifierModule.parseVeraPdfValidationResult,
      image: legalVerifierModule.VERAPDF_RELEASE_IMAGE,
      version: legalVerifierModule.VERAPDF_VERSION,
    });
  const pdfaValidatedFiles = await collectFreshPdfAEvidence(rootDir, attestation, validatePdf);
  const verifyArtifactManifest = injectedVerifier ?? legalVerifierModule.verifyArtifactManifest;
  return verifyArtifactManifest({
    rootDir,
    manifestPath,
    pdfaValidatedFiles,
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
