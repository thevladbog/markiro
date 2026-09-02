import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  LEGAL_RELEASES,
  legalDocumentKind,
  legalReleaseLocales,
  legalRevisionFileToken,
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
  /^markiro_mkr-(?:pd-0[12]|dpa-01|brd-01|ins-0[123456789])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
const SHA256 = /^[a-f0-9]{64}$/;
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

function lexicalAncestors(target: string): readonly string[] {
  const absolute = path.resolve(target);
  const { root } = path.parse(absolute);
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  const ancestors = [root];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    ancestors.push(current);
  }
  return ancestors;
}

interface PathIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

async function snapshotNoSymlinkAncestors(
  target: string,
  label: string,
): Promise<readonly PathIdentity[]> {
  const identities: PathIdentity[] = [];
  for (const ancestor of lexicalAncestors(target)) {
    const stat = await lstat(ancestor);
    if (stat.isSymbolicLink()) {
      fail(`${label} must not contain a symbolic link`);
    }
    identities.push({ path: ancestor, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

async function assertSamePathIdentities(
  expected: readonly PathIdentity[],
  label: string,
): Promise<void> {
  const current = await snapshotNoSymlinkAncestors(expected.at(-1)?.path ?? "", label);
  const unchanged =
    current.length === expected.length &&
    current.every(
      (identity, index) =>
        identity.path === expected[index]?.path &&
        identity.dev === expected[index]?.dev &&
        identity.ino === expected[index]?.ino,
    );
  if (!unchanged) fail(`${label} or one of its ancestors changed while it was being read`);
}

async function snapshotStableDirectory(
  target: string,
  label: string,
): Promise<readonly PathIdentity[]> {
  const identities = await snapshotNoSymlinkAncestors(target, label);
  const stat = await lstat(target);
  if (!stat.isDirectory()) fail(`${label} must be a directory`);
  if ((await realpath(target)) !== path.resolve(target)) {
    fail(`${label} must not resolve through a symbolic link`);
  }
  return identities;
}

async function readStableRegularFile(
  target: string,
  label: string,
  stableTree?: readonly PathIdentity[],
): Promise<Buffer> {
  if (stableTree !== undefined) await assertSamePathIdentities(stableTree, label);
  const pathIdentities = await snapshotNoSymlinkAncestors(target, label);
  if ((await realpath(target)) !== path.resolve(target)) {
    fail(`${label} must not resolve through a symbolic link`);
  }

  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail(`${label} must be a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();

    await assertSamePathIdentities(pathIdentities, label);
    if (stableTree !== undefined) await assertSamePathIdentities(stableTree, label);
    const current = await lstat(target);
    const stableHandle =
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs;
    const stablePath =
      current.isFile() &&
      current.dev === after.dev &&
      current.ino === after.ino &&
      (await realpath(target)) === path.resolve(target);
    if (!stableHandle || !stablePath) fail(`${label} changed while it was being read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertExactArtifactDirectory(
  filesRoot: string,
  expectedNames: ReadonlySet<string>,
  stableTree: readonly PathIdentity[],
): Promise<void> {
  await assertSamePathIdentities(stableTree, "artifact directory");
  const entries = await readdir(filesRoot, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) {
    fail("artifact directory must not contain a symbolic link");
  }
  const exactEntries =
    entries.length === expectedNames.size &&
    entries.every((entry) => entry.isFile() && expectedNames.has(entry.name));
  if (!exactEntries) fail("artifact directory contains an unlisted or non-file entry");
  await assertSamePathIdentities(stableTree, "artifact directory");
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
  revision: LegalDocumentRelease["revision"],
  locale: LegalLocale,
  kind: PublishedLegalArtifactKind,
): string {
  return `markiro_${code.toLowerCase()}_${legalRevisionFileToken(revision)}_${locale}.${kind === "pdfa-2b" ? "pdf" : "docx"}`;
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
  if (!legalReleaseLocales(release.code).includes(value.locale)) {
    fail("locale is not published for this code");
  }
  if (value.kind !== "pdfa-2b" && value.kind !== "template-docx") fail("kind is invalid");
  if (value.kind === "template-docx" && legalDocumentKind(release.code) !== "template") {
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
    for (const locale of legalReleaseLocales(release.code)) {
      expected.add(descriptorKey({ ...release, locale, kind: "pdfa-2b" }));
      if (legalDocumentKind(release.code) === "template") {
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
  const lexicalPublicRoot = path.resolve(publicRoot);
  const legalRoot = path.join(lexicalPublicRoot, "legal");
  const filesRoot = path.join(legalRoot, "files");
  const manifestPath = path.join(legalRoot, "artifacts.json");
  await snapshotStableDirectory(lexicalPublicRoot, "public root");
  await snapshotStableDirectory(legalRoot, "legal directory");
  const stableTree = await snapshotStableDirectory(filesRoot, "artifact directory");

  let manifest: unknown;
  try {
    manifest = JSON.parse(
      (await readStableRegularFile(manifestPath, "manifest", stableTree)).toString("utf8"),
    );
  } catch {
    fail("manifest is not valid JSON");
  }
  if (!Array.isArray(manifest)) fail("manifest must be an array");

  const artifacts: PublishedLegalArtifact[] = [];
  const keys = new Set<string>();
  const fileNames = new Set<string>();
  const parsedArtifacts: Omit<PublishedLegalArtifact, "href">[] = [];
  for (const raw of manifest) {
    const parsed = parseArtifact(raw);
    const key = descriptorKey(parsed);
    if (keys.has(key)) fail("descriptor is duplicated");
    keys.add(key);
    if (fileNames.has(parsed.fileName)) fail("artifact fileName is duplicated");
    fileNames.add(parsed.fileName);
    parsedArtifacts.push(parsed);
  }

  await assertExactArtifactDirectory(filesRoot, fileNames, stableTree);
  for (const parsed of parsedArtifacts) {
    const artifactPath = path.join(filesRoot, parsed.fileName);
    const bytes = await readStableRegularFile(artifactPath, "artifact file", stableTree);

    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== parsed.bytes || digest !== parsed.sha256) {
      fail("artifact bytes do not match the immutable manifest");
    }
    artifacts.push({ ...parsed, href: `/legal/files/${parsed.fileName}` });
  }

  await assertExactArtifactDirectory(filesRoot, fileNames, stableTree);
  await assertSamePathIdentities(stableTree, "artifact directory");

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
