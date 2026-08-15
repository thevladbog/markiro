import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  LEGAL_RELEASES,
  type LegalDocumentCode,
  type LegalDocumentRelease,
  type LegalLocale,
} from "@markiro/legal-documents";

export type PublishedLegalArtifactKind = "pdfa-2b" | "template-docx";

export interface PublishedLegalArtifact {
  readonly code: LegalDocumentCode;
  readonly revision: string;
  readonly effectiveDate: string;
  readonly locale: LegalLocale;
  readonly kind: PublishedLegalArtifactKind;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mediaType:
    "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  readonly generator: {
    readonly docx: "9.7.1";
    readonly libreOffice?: "26.2.5";
    readonly veraPdf?: "1.30.2";
  };
  readonly href: `/legal/files/${string}`;
}

const DEFAULT_PUBLIC_ROOT = path.resolve(process.cwd(), "public");
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-0[12]|dpa-01|brd-01)_\d{4}\.\d{2}\.\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TEMPLATE_CODES = new Set<LegalDocumentCode>(["MKR-DPA-01", "MKR-BRD-01"]);
const PUBLISHED_RELEASES = (LEGAL_RELEASES as readonly LegalDocumentRelease[]).filter(
  ({ status }) => status !== "draft",
);
const ARTIFACT_KEYS = [
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
] as const;

function fail(detail: string): never {
  throw new Error(`Invalid legal artifact manifest: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected fields`);
  }
}

function expectedFileName(
  code: LegalDocumentCode,
  revision: string,
  locale: LegalLocale,
  kind: PublishedLegalArtifactKind,
): string {
  return `markiro_${code.toLowerCase()}_${revision}_${locale}.${kind === "pdfa-2b" ? "pdf" : "docx"}`;
}

function descriptorKey(
  value: Pick<PublishedLegalArtifact, "code" | "revision" | "locale" | "kind">,
): string {
  return `${value.code}/${value.revision}/${value.locale}/${value.kind}`;
}

function findRelease(
  code: unknown,
  revision: unknown,
  effectiveDate: unknown,
): LegalDocumentRelease {
  const release = PUBLISHED_RELEASES.find(
    (candidate) =>
      candidate.code === code &&
      candidate.revision === revision &&
      candidate.effectiveDate === effectiveDate,
  );
  if (release === undefined) fail("descriptor does not match a released legal document");
  return release;
}

function parseArtifact(value: unknown): Omit<PublishedLegalArtifact, "href"> {
  if (!isRecord(value)) fail("entry must be an object");
  assertExactKeys(value, ARTIFACT_KEYS, "entry");

  const release = findRelease(value.code, value.revision, value.effectiveDate);
  if (value.locale !== "ru" && value.locale !== "en") fail("locale is invalid");
  if (value.kind !== "pdfa-2b" && value.kind !== "template-docx") fail("kind is invalid");
  if (value.kind === "template-docx" && !TEMPLATE_CODES.has(release.code)) {
    fail("DOCX is allowed only for template releases");
  }
  if (typeof value.fileName !== "string" || !SAFE_FILE_NAME.test(value.fileName)) {
    fail("fileName must be a safe basename");
  }
  if (path.basename(value.fileName) !== value.fileName || value.fileName.includes("/")) {
    fail("fileName must not contain path separators");
  }
  if (
    value.fileName !== expectedFileName(release.code, release.revision, value.locale, value.kind)
  ) {
    fail("fileName does not match its descriptor");
  }
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) fail("bytes is invalid");
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) fail("sha256 is invalid");

  const expectedMediaType =
    value.kind === "pdfa-2b"
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (value.mediaType !== expectedMediaType) fail("mediaType does not match kind");
  if (!isRecord(value.generator)) fail("generator is invalid");
  const generatorKeys = value.kind === "pdfa-2b" ? ["docx", "libreOffice", "veraPdf"] : ["docx"];
  assertExactKeys(value.generator, generatorKeys, "generator");
  if (value.generator.docx !== "9.7.1") fail("DOCX generator version is invalid");
  if (
    value.kind === "pdfa-2b" &&
    (value.generator.libreOffice !== "26.2.5" || value.generator.veraPdf !== "1.30.2")
  ) {
    fail("PDF/A generator versions are invalid");
  }

  return {
    code: release.code,
    revision: release.revision,
    effectiveDate: release.effectiveDate,
    locale: value.locale,
    kind: value.kind,
    fileName: value.fileName,
    bytes: value.bytes as number,
    sha256: value.sha256,
    mediaType: expectedMediaType,
    generator:
      value.kind === "pdfa-2b"
        ? { docx: "9.7.1", libreOffice: "26.2.5", veraPdf: "1.30.2" }
        : { docx: "9.7.1" },
  };
}

function assertCompleteReleaseSet(artifacts: readonly PublishedLegalArtifact[]): void {
  const actual = new Set(artifacts.map(descriptorKey));
  const expected = new Set<string>();
  for (const release of PUBLISHED_RELEASES) {
    for (const locale of ["ru", "en"] as const) {
      expected.add(descriptorKey({ ...release, locale, kind: "pdfa-2b" }));
      if (TEMPLATE_CODES.has(release.code)) {
        expected.add(descriptorKey({ ...release, locale, kind: "template-docx" }));
      }
    }
  }
  if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
    fail("released artifact set is incomplete or duplicated");
  }
}

export async function loadLegalArtifacts(
  publicRoot: string = DEFAULT_PUBLIC_ROOT,
): Promise<readonly PublishedLegalArtifact[]> {
  const resolvedPublicRoot = await realpath(publicRoot);
  const legalRoot = path.join(resolvedPublicRoot, "legal");
  const filesRoot = path.join(legalRoot, "files");
  const manifestPath = path.join(legalRoot, "artifacts.json");
  for (const [target, label] of [
    [legalRoot, "legal directory"],
    [filesRoot, "artifact directory"],
    [manifestPath, "manifest"],
  ] as const) {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) fail(`${label} must not be a symbolic link`);
  }
  const resolvedFilesRoot = await realpath(filesRoot);
  if (path.dirname(resolvedFilesRoot) !== (await realpath(legalRoot))) {
    fail("artifact directory is outside /legal/files/");
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("manifest is not valid JSON");
  }
  if (!Array.isArray(manifest)) fail("manifest must be an array");

  const artifacts: PublishedLegalArtifact[] = [];
  const keys = new Set<string>();
  for (const raw of manifest) {
    const parsed = parseArtifact(raw);
    const key = descriptorKey(parsed);
    if (keys.has(key)) fail("descriptor is duplicated");
    keys.add(key);

    const artifactPath = path.join(resolvedFilesRoot, parsed.fileName);
    const stat = await lstat(artifactPath);
    if (stat.isSymbolicLink()) fail("artifact file must not be a symbolic link");
    if (!stat.isFile()) fail("artifact path must be a regular file");
    const resolvedArtifact = await realpath(artifactPath);
    if (path.dirname(resolvedArtifact) !== resolvedFilesRoot) {
      fail("artifact file is outside /legal/files/");
    }
    const bytes = await readFile(resolvedArtifact);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== parsed.bytes || digest !== parsed.sha256) {
      fail("artifact bytes do not match the immutable manifest");
    }
    artifacts.push({ ...parsed, href: `/legal/files/${parsed.fileName}` });
  }

  assertCompleteReleaseSet(artifacts);
  return artifacts.sort((left, right) => descriptorKey(left).localeCompare(descriptorKey(right)));
}

export function artifactsForRelease(
  artifacts: readonly PublishedLegalArtifact[],
  code: LegalDocumentCode,
  revision: string,
  locale?: LegalLocale,
): readonly PublishedLegalArtifact[] {
  return artifacts.filter(
    (artifact) =>
      artifact.code === code &&
      artifact.revision === revision &&
      (locale === undefined || artifact.locale === locale),
  );
}

export function legalVerificationPath(
  release: Pick<LegalDocumentRelease, "code" | "revision" | "effectiveDate">,
): `/d/${string}/${string}/${string}/` {
  return `/d/${release.code}/${release.revision}/${release.effectiveDate}/`;
}

export function legalVerificationUrl(
  release: Pick<LegalDocumentRelease, "code" | "revision" | "effectiveDate">,
): `https://markiro.app/d/${string}/${string}/${string}` {
  return `https://markiro.app/d/${release.code}/${release.revision}/${release.effectiveDate}`;
}
