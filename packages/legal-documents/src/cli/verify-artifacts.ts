import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LEGAL_RELEASES, legalDocumentKind, legalReleaseLocales } from "../registry.js";
import { legalVerificationUrl } from "../identity.js";
import type { LegalDocumentCode, LegalLocale } from "../types.js";
import { artifactFileName } from "../artifacts/names.js";

export const MAX_LEGAL_PDF_BYTES = 5 * 1024 * 1024;
export const MAX_INSTRUCTION_PDF_BYTES = 12 * 1024 * 1024;
export const VERAPDF_VERSION = "1.30.2";
export const VERAPDF_RELEASE_IMAGE =
  "docker.io/verapdf/cli@sha256:d5ee329657cf9bc4b2400392dd54c7d0a0ce9980ff6fa2da5590eebeec007cdb";

export function maxLegalPdfBytes(code: LegalDocumentCode): number {
  return legalDocumentKind(code) === "instruction"
    ? MAX_INSTRUCTION_PDF_BYTES
    : MAX_LEGAL_PDF_BYTES;
}

const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
const LEGAL_DOCUMENT_CODES = [
  "MKR-PD-01",
  "MKR-PD-02",
  "MKR-DPA-01",
  "MKR-BRD-01",
  "MKR-INS-01",
  "MKR-INS-02",
  "MKR-INS-03",
  "MKR-INS-04",
  "MKR-INS-05",
  "MKR-INS-06",
  "MKR-INS-07",
  "MKR-INS-08",
] as const;
const LEGAL_LOCALES = ["ru", "en"] as const;
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-01|pd-02|dpa-01|brd-01|ins-0[12345678])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface PublishedLegalArtifact {
  readonly code: LegalDocumentCode;
  readonly revision: string;
  readonly effectiveDate: string;
  readonly locale: LegalLocale;
  readonly kind: "pdfa-2b" | "template-docx";
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mediaType: "application/pdf" | typeof DOCX_MEDIA_TYPE;
  readonly generator: {
    readonly docx: "9.7.1";
    readonly libreOffice?: "26.2.5";
    readonly veraPdf?: "1.30.2";
  };
}

export interface VerifyArtifactManifestOptions {
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly pdfaValidatedFiles: ReadonlySet<string>;
}

export function parseVerificationArguments(args: readonly string[]): { readonly outDir: string } {
  let outDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--out-dir") {
      throw new Error(`Unknown artifact verification argument: ${String(argument)}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--out-dir requires a value");
    if (outDir) throw new Error("--out-dir may be supplied only once");
    outDir = value;
    index += 1;
  }
  if (!outDir) throw new Error("Artifact verification requires explicit --out-dir");
  return { outDir };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function parseVeraPdfValidationResult(output: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("veraPDF did not return a machine-readable JSON result");
  }
  if (!isRecord(parsed) || !("report" in parsed)) {
    throw new Error("veraPDF machine-readable result is missing its report");
  }
  const report = parsed.report;
  if (!isRecord(report)) {
    throw new Error("veraPDF machine-readable result has an invalid report");
  }
  const jobsValue: unknown = report.jobs;
  const jobs: readonly unknown[] = Array.isArray(jobsValue)
    ? (jobsValue as readonly unknown[])
    : [];
  const summary: unknown = report.batchSummary;
  const firstJob: unknown = jobs[0];
  const validationResults: readonly unknown[] =
    isRecord(firstJob) && Array.isArray(firstJob.validationResult)
      ? (firstJob.validationResult as readonly unknown[])
      : [];
  const validationResult: unknown = validationResults[0];
  const validationDetails: unknown = isRecord(validationResult)
    ? validationResult.details
    : undefined;
  const validationSummary: unknown = isRecord(summary) ? summary.validationSummary : undefined;
  const featuresSummary: unknown = isRecord(summary) ? summary.featuresSummary : undefined;
  const repairSummary: unknown = isRecord(summary) ? summary.repairSummary : undefined;
  const conformant =
    jobs.length === 1 &&
    validationResults.length === 1 &&
    isRecord(validationResult) &&
    validationResult.compliant === true &&
    validationResult.jobEndStatus === "normal" &&
    validationResult.profileName === "PDF/A-2b validation profile" &&
    isRecord(validationDetails) &&
    validationDetails.failedRules === 0 &&
    validationDetails.failedChecks === 0;
  const summaryConformant =
    isRecord(summary) &&
    summary.totalJobs === 1 &&
    summary.outOfMemory === 0 &&
    summary.veraExceptions === 0 &&
    summary.multiJob === false &&
    summary.failedEncryptedJobs === 0 &&
    summary.failedParsingJobs === 0 &&
    isRecord(featuresSummary) &&
    featuresSummary.failedJobCount === 0 &&
    featuresSummary.totalJobCount === 0 &&
    featuresSummary.successfulJobCount === 0 &&
    isRecord(repairSummary) &&
    repairSummary.failedJobCount === 0 &&
    repairSummary.totalJobCount === 0 &&
    repairSummary.successfulJobCount === 0 &&
    isRecord(validationSummary) &&
    validationSummary.totalJobCount === 1 &&
    validationSummary.successfulJobCount === 1 &&
    validationSummary.failedJobCount === 0 &&
    validationSummary.compliantPdfaCount === 1 &&
    validationSummary.nonCompliantPdfaCount === 0;
  if (!conformant || !summaryConformant) {
    throw new Error("Generated PDF is not conformant with PDF/A-2b according to veraPDF");
  }
}

function assertInsideRoot(rootDir: string, candidatePath: string): void {
  const relative = path.relative(rootDir, candidatePath);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(`Manifest must be inside the artifact root: ${candidatePath}`);
}

function parseGenerator(
  value: unknown,
  kind: PublishedLegalArtifact["kind"],
): PublishedLegalArtifact["generator"] {
  if (!isRecord(value)) throw new Error("Artifact generator evidence must be an object");
  if (kind === "pdfa-2b") {
    if (
      !hasExactKeys(value, ["docx", "libreOffice", "veraPdf"].sort()) ||
      value.docx !== "9.7.1" ||
      value.libreOffice !== "26.2.5" ||
      value.veraPdf !== "1.30.2"
    ) {
      throw new Error("PDF artifact is missing pinned PDF/A validation evidence");
    }
    return { docx: "9.7.1", libreOffice: "26.2.5", veraPdf: "1.30.2" };
  }

  if (!hasExactKeys(value, ["docx"]) || value.docx !== "9.7.1") {
    throw new Error("DOCX artifact has invalid generator evidence");
  }
  return { docx: "9.7.1" };
}

function parseArtifact(value: unknown, index: number): PublishedLegalArtifact {
  if (!isRecord(value)) throw new Error(`Artifact descriptor ${index} must be an object`);
  const expectedKeys = [
    "bytes",
    "code",
    "effectiveDate",
    "fileName",
    "generator",
    "kind",
    "locale",
    "mediaType",
    "revision",
    "sha256",
  ].sort();
  if (!hasExactKeys(value, expectedKeys)) {
    throw new Error(`Artifact descriptor ${index} has unexpected or missing fields`);
  }
  if (!(LEGAL_DOCUMENT_CODES as readonly unknown[]).includes(value.code)) {
    throw new Error(`Invalid legal artifact code: ${String(value.code)}`);
  }
  if (!(LEGAL_LOCALES as readonly unknown[]).includes(value.locale)) {
    throw new Error(`Invalid legal artifact locale: ${String(value.locale)}`);
  }
  if (value.kind !== "pdfa-2b" && value.kind !== "template-docx") {
    throw new Error(`Invalid legal artifact kind: ${String(value.kind)}`);
  }
  if (typeof value.revision !== "string" || typeof value.effectiveDate !== "string") {
    throw new Error(`Artifact descriptor ${index} has invalid release metadata`);
  }
  if (
    typeof value.fileName !== "string" ||
    !SAFE_FILE_NAME.test(value.fileName) ||
    path.basename(value.fileName) !== value.fileName
  ) {
    throw new Error(`Unsafe legal artifact file name: ${String(value.fileName)}`);
  }
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) {
    throw new Error(`Artifact ${value.fileName} has invalid byte size`);
  }
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
    throw new Error(`Artifact ${value.fileName} has invalid SHA-256`);
  }

  const code = value.code as LegalDocumentCode;
  const locale = value.locale as LegalLocale;
  const kind = value.kind;
  const expectedMediaType = kind === "pdfa-2b" ? "application/pdf" : DOCX_MEDIA_TYPE;
  if (value.mediaType !== expectedMediaType) {
    throw new Error(`Artifact ${value.fileName} has invalid media type`);
  }
  const release = LEGAL_RELEASES.find(
    (candidate) =>
      candidate.code === code &&
      candidate.revision === value.revision &&
      candidate.effectiveDate === value.effectiveDate &&
      candidate.status === "active",
  );
  if (!release) {
    throw new Error(`Artifact is not a current release: ${code}/${value.revision}`);
  }
  if (!legalReleaseLocales(code).includes(locale)) {
    throw new Error(`Artifact locale is not published for ${code}: ${locale}`);
  }
  if (kind === "template-docx" && legalDocumentKind(code) !== "template") {
    throw new Error(`Legal artifact is not a downloadable template: ${code}`);
  }

  const expectedFileName = artifactFileName({
    code,
    revision: release.revision,
    effectiveDate: release.effectiveDate,
    locale,
    kind: kind === "pdfa-2b" ? "legal-pdf" : "template-docx",
    verificationUrl: legalVerificationUrl(release),
  });
  if (value.fileName !== expectedFileName) {
    throw new Error(`Artifact file name does not match its descriptor: ${value.fileName}`);
  }

  return {
    code,
    revision: value.revision,
    effectiveDate: value.effectiveDate,
    locale,
    kind,
    fileName: value.fileName,
    bytes: value.bytes as number,
    sha256: value.sha256,
    mediaType: expectedMediaType,
    generator: parseGenerator(value.generator, kind),
  };
}

function canonicalEntry(entry: PublishedLegalArtifact): PublishedLegalArtifact {
  return {
    code: entry.code,
    revision: entry.revision,
    effectiveDate: entry.effectiveDate,
    locale: entry.locale,
    kind: entry.kind,
    fileName: entry.fileName,
    bytes: entry.bytes,
    sha256: entry.sha256,
    mediaType: entry.mediaType,
    generator:
      entry.kind === "pdfa-2b"
        ? { docx: "9.7.1", libreOffice: "26.2.5", veraPdf: "1.30.2" }
        : { docx: "9.7.1" },
  };
}

export function canonicalArtifactManifest(entries: readonly PublishedLegalArtifact[]): string {
  const canonical = [...entries]
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
    .map((entry) => canonicalEntry(entry));
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function expectedArtifactKeys(): Set<string> {
  const keys = new Set<string>();
  for (const release of LEGAL_RELEASES) {
    if (release.status !== "active") continue;
    for (const locale of legalReleaseLocales(release.code)) {
      keys.add(`${release.code}|${release.revision}|${locale}|pdfa-2b`);
      if (legalDocumentKind(release.code) === "template") {
        keys.add(`${release.code}|${release.revision}|${locale}|template-docx`);
      }
    }
  }
  return keys;
}

function artifactKey(entry: PublishedLegalArtifact): string {
  return `${entry.code}|${entry.revision}|${entry.locale}|${entry.kind}`;
}

async function assertOrdinaryFile(filePath: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw new Error(`Legal artifact file is missing: ${filePath}`, { cause: error });
    }
    throw error;
  }
  if (stats.isSymbolicLink())
    throw new Error(`Legal artifact must not be a symbolic link: ${filePath}`);
  if (!stats.isFile()) throw new Error(`Legal artifact must be an ordinary file: ${filePath}`);
  return stats;
}

export async function verifyArtifactManifest(
  options: VerifyArtifactManifestOptions,
): Promise<PublishedLegalArtifact[]> {
  const rootDir = path.resolve(options.rootDir);
  const manifestPath = path.resolve(options.manifestPath);
  assertInsideRoot(rootDir, manifestPath);

  const rootStats = await lstat(rootDir);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Artifact root must be an ordinary directory: ${rootDir}`);
  }
  const rootEntries = (await readdir(rootDir)).sort();
  if (JSON.stringify(rootEntries) !== JSON.stringify(["artifacts.json", "files"])) {
    throw new Error(
      `Unexpected artifact root entry; expected only artifacts.json and files: ${rootEntries.join(", ")}`,
    );
  }
  await assertOrdinaryFile(manifestPath);
  const filesDir = path.join(rootDir, "files");
  const filesStats = await lstat(filesDir);
  if (filesStats.isSymbolicLink() || !filesStats.isDirectory()) {
    throw new Error(`Artifact files path must be an ordinary directory: ${filesDir}`);
  }

  const manifestBytes = await readFile(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error("Legal artifact manifest is not valid JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error("Legal artifact manifest must be an array");
  const entries = parsed.map((entry, index) => parseArtifact(entry, index));

  const fileNames = new Set<string>();
  const descriptorKeys = new Set<string>();
  for (const entry of entries) {
    if (fileNames.has(entry.fileName)) {
      throw new Error(`Duplicate legal artifact file name: ${entry.fileName}`);
    }
    fileNames.add(entry.fileName);
    const key = artifactKey(entry);
    if (descriptorKeys.has(key)) throw new Error(`Duplicate legal artifact descriptor: ${key}`);
    descriptorKeys.add(key);
  }

  const expectedKeys = expectedArtifactKeys();
  for (const expectedKey of expectedKeys) {
    if (!descriptorKeys.has(expectedKey)) {
      throw new Error(`Manifest omits a current release artifact: ${expectedKey}`);
    }
  }
  for (const key of descriptorKeys) {
    if (!expectedKeys.has(key)) throw new Error(`Manifest lists a non-current artifact: ${key}`);
  }

  if (manifestBytes.toString("utf8") !== canonicalArtifactManifest(entries)) {
    throw new Error("Legal artifact manifest is not canonical sorted JSON with a final newline");
  }

  const diskEntries = await readdir(filesDir, { withFileTypes: true });
  for (const diskEntry of diskEntries) {
    if (diskEntry.isSymbolicLink()) {
      throw new Error(`Legal artifact must not be a symbolic link: ${diskEntry.name}`);
    }
    if (!diskEntry.isFile())
      throw new Error(`Unexpected non-file artifact entry: ${diskEntry.name}`);
    if (!fileNames.has(diskEntry.name))
      throw new Error(`Unexpected extra artifact file: ${diskEntry.name}`);
  }
  for (const fileName of fileNames) {
    if (!diskEntries.some((entry) => entry.name === fileName)) {
      throw new Error(`Legal artifact file is missing: ${fileName}`);
    }
  }

  for (const entry of entries) {
    const artifactPath = path.join(filesDir, entry.fileName);
    const stats = await assertOrdinaryFile(artifactPath);
    if (stats.size !== entry.bytes) {
      throw new Error(`Legal artifact size mismatch: ${entry.fileName}`);
    }
    if (entry.kind === "pdfa-2b" && stats.size > maxLegalPdfBytes(entry.code)) {
      throw new Error(`Legal PDF exceeds its release size bound: ${entry.fileName}`);
    }
    const digest = createHash("sha256")
      .update(await readFile(artifactPath))
      .digest("hex");
    if (digest !== entry.sha256) {
      throw new Error(`Legal artifact SHA-256 mismatch: ${entry.fileName}`);
    }
    if (entry.kind === "pdfa-2b" && !options.pdfaValidatedFiles.has(entry.fileName)) {
      throw new Error(`Legal PDF was not validated as PDF/A-2b in this run: ${entry.fileName}`);
    }
  }

  return [...entries].sort((left, right) => left.fileName.localeCompare(right.fileName));
}

async function main(): Promise<void> {
  const { outDir } = parseVerificationArguments(process.argv.slice(2));
  const sofficeBin = process.env.SOFFICE_BIN;
  if (!sofficeBin) throw new Error("Artifact verification requires explicit SOFFICE_BIN");
  const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const { generateLegalArtifacts } = await import("./generate-artifacts.js");
  const entries = await generateLegalArtifacts({
    repositoryRoot,
    outDir,
    sofficeBin,
    preview: false,
    check: true,
  });
  process.stdout.write(
    `Verified ${entries.length} immutable legal artifacts at ${path.resolve(outDir)}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
