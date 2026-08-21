import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve, sep, win32 } from "node:path";

export const MAX_EVIDENCE_FILE_COUNT = 10_000;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const MAX_RELATIVE_PATH_BYTES = 4096;
const MAX_CHECKSUM_BYTES = 48 * 1024 * 1024;
const MANIFEST_NAME = "manifest.json";
const CHECKSUMS_NAME = "SHA256SUMS";
const SHA256 = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^INV-\d{8}-[a-z0-9-]{2,40}-\d{2}$/;
const directCodePointCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export class EvidencePackageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "EvidencePackageError";
  }
}

function invalid(message, options) {
  throw new EvidencePackageError(message, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeJson(value, context = "manifest") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, context));
  if (!isPlainObject(value)) invalid(`${context} contains a non-JSON value`);

  const normalized = {};
  for (const key of Object.keys(value).sort(directCodePointCompare)) {
    if (value[key] === undefined) invalid(`${context} contains an undefined value`);
    normalized[key] = normalizeJson(value[key], context);
  }
  return normalized;
}

function displayPath(relativePath) {
  return relativePath.length > 180 ? `${relativePath.slice(0, 177)}...` : relativePath;
}

function normalizeRelativePath(relativePath, label = "artifact path") {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    invalid(`empty ${label}`);
  }
  if (
    relativePath.includes("\0") ||
    relativePath.includes("\n") ||
    relativePath.includes("\r") ||
    Buffer.byteLength(relativePath) > MAX_RELATIVE_PATH_BYTES
  ) {
    invalid(`unsafe ${label}`);
  }
  if (
    isAbsolute(relativePath) ||
    posix.isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath)
  ) {
    invalid(`absolute ${label}: ${displayPath(relativePath)}`);
  }
  if (relativePath.includes("\\")) invalid(`non-POSIX ${label}: ${displayPath(relativePath)}`);

  const normalized = posix.normalize(relativePath);
  const parts = relativePath.split("/");
  if (
    normalized !== relativePath ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    invalid(`unsafe ${label}: ${displayPath(relativePath)}`);
  }
  return normalized;
}

function isContained(root, target) {
  return target !== root && target.startsWith(`${root}${sep}`);
}

function assertContained(root, target, relativePath) {
  if (!isContained(root, target)) {
    invalid(`artifact path escapes operation root: ${displayPath(relativePath)}`);
  }
}

async function resolveExistingRoot(root) {
  if (typeof root !== "string" || root.length === 0) invalid("evidence root is required");
  const absolute = resolve(root);
  let information;
  try {
    information = await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") invalid("evidence root does not exist", { cause: error });
    throw error;
  }
  if (information.isSymbolicLink()) invalid("evidence root must not be a symlink");
  if (!information.isDirectory()) invalid("evidence root must be a directory");
  return realpath(absolute);
}

async function safeExistingFile(root, relativePath, missingMessage) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/");
  let current = root;

  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    assertContained(root, current, normalized);
    let information;
    try {
      information = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" && missingMessage) invalid(missingMessage, { cause: error });
      throw error;
    }
    if (information.isSymbolicLink()) invalid(`symlink is not allowed: ${displayPath(normalized)}`);
    if (index < segments.length - 1 && !information.isDirectory()) {
      invalid(`artifact parent is not a directory: ${displayPath(normalized)}`);
    }
    if (index === segments.length - 1 && !information.isFile()) {
      invalid(`artifact is not a regular file: ${displayPath(normalized)}`);
    }
  }

  const resolvedFile = await realpath(current);
  assertContained(root, resolvedFile, normalized);
  return resolvedFile;
}

async function hashOpenFile(filePath) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const information = await handle.stat();
    if (!information.isFile()) invalid("path is not a regular file");
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    return { byteSize: information.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function inspectArtifact(root, relativePath, missingMessage) {
  const filePath = await safeExistingFile(root, relativePath, missingMessage);
  return hashOpenFile(filePath);
}

function shouldExclude(relativePath, includeManifest) {
  if (relativePath === CHECKSUMS_NAME) return true;
  if (!includeManifest && relativePath === MANIFEST_NAME) return true;
  return basename(relativePath).endsWith(".tmp");
}

async function enumerateRegularFiles(root, { includeManifest = false } = {}) {
  const files = [];
  const directories = [{ absolute: root, relative: "" }];

  while (directories.length > 0) {
    const directory = directories.pop();
    const entries = await readdir(directory.absolute, { withFileTypes: true });
    entries.sort((left, right) => directCodePointCompare(left.name, right.name));

    for (const entry of entries) {
      const relativePath = normalizeRelativePath(
        directory.relative ? `${directory.relative}/${entry.name}` : entry.name,
      );
      const absolutePath = resolve(directory.absolute, entry.name);
      assertContained(root, absolutePath, relativePath);
      const information = await lstat(absolutePath);
      if (information.isSymbolicLink()) {
        invalid(`symlink is not allowed: ${displayPath(relativePath)}`);
      }

      const resolvedPath = await realpath(absolutePath);
      assertContained(root, resolvedPath, relativePath);
      if (information.isDirectory()) {
        directories.push({ absolute: resolvedPath, relative: relativePath });
      } else if (information.isFile()) {
        if (!shouldExclude(relativePath, includeManifest)) {
          files.push(relativePath);
          const allowed = MAX_EVIDENCE_FILE_COUNT + (includeManifest ? 1 : 0);
          if (files.length > allowed) {
            invalid(`evidence file count limit exceeded (${MAX_EVIDENCE_FILE_COUNT})`);
          }
        }
      } else {
        invalid(`non-regular artifact is not allowed: ${displayPath(relativePath)}`);
      }
    }
  }

  return files.sort(directCodePointCompare);
}

async function readBoundedUtf8(root, relativePath, limit, sizeLabel, missingMessage) {
  const filePath = await safeExistingFile(root, relativePath, missingMessage);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const information = await handle.stat();
    if (!information.isFile()) invalid(`${relativePath} is not a regular file`);
    if (information.size > limit) invalid(`${sizeLabel} size limit exceeded`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    invalid("manifest.json is not valid JSON", { cause: error });
  }
  if (!isPlainObject(manifest)) invalid("manifest.json must contain an object");
  if (!OPERATION_ID.test(manifest.operationId)) invalid("manifest has an invalid operation id");
  if (manifest.artifacts !== undefined && !Array.isArray(manifest.artifacts)) {
    invalid("manifest artifacts must be an array");
  }
  return manifest;
}

function priorArtifactsByPath(draft) {
  const priorByPath = new Map();
  for (const artifact of draft.artifacts ?? []) {
    if (!isPlainObject(artifact)) invalid("manifest artifact metadata must be an object");
    const relativePath = normalizeRelativePath(artifact.path, "manifest artifact path");
    if (priorByPath.has(relativePath)) {
      invalid(`duplicate manifest artifact path: ${displayPath(relativePath)}`);
    }
    priorByPath.set(relativePath, artifact);
  }
  return priorByPath;
}

async function buildManifestAtRoot(root, draft) {
  if (!isPlainObject(draft)) invalid("manifest draft must be an object");
  if (!OPERATION_ID.test(draft.operationId)) invalid("manifest has an invalid operation id");
  if (draft.artifacts !== undefined && !Array.isArray(draft.artifacts)) {
    invalid("manifest artifacts must be an array");
  }

  const priorByPath = priorArtifactsByPath(draft);
  const paths = await enumerateRegularFiles(root);
  const artifacts = [];
  for (const relativePath of paths) {
    const { byteSize, sha256 } = await inspectArtifact(
      root,
      relativePath,
      `artifact disappeared while sealing: ${displayPath(relativePath)}`,
    );
    const prior = priorByPath.get(relativePath);
    const physicalBoxRefs = prior?.physicalBoxRefs ?? [];
    const evidenceRefs = prior?.evidenceRefs ?? [];
    if (!Array.isArray(physicalBoxRefs) || !Array.isArray(evidenceRefs)) {
      invalid(`manifest references must be arrays: ${displayPath(relativePath)}`);
    }
    artifacts.push({
      path: relativePath,
      category: relativePath.split("/", 1)[0],
      byteSize,
      sha256,
      capturedAt: normalizeJson(prior?.capturedAt ?? draft.updatedAt ?? null),
      actor: normalizeJson(prior?.actor ?? draft.operator ?? null),
      physicalBoxRefs: normalizeJson(physicalBoxRefs),
      evidenceRefs: normalizeJson(evidenceRefs),
    });
  }

  const normalized = {};
  for (const key of Object.keys(draft)
    .filter((key) => key !== "artifacts")
    .sort(directCodePointCompare)) {
    if (draft[key] === undefined) invalid("manifest contains an undefined value");
    normalized[key] = normalizeJson(draft[key]);
  }
  normalized.artifacts = artifacts;
  return normalized;
}

function serializeManifest(manifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) invalid("manifest size limit exceeded");
  return text;
}

async function writeSiblingTemporary(target, contents) {
  const temporary = join(dirname(target), `${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function existingGeneratedFile(target) {
  try {
    const information = await lstat(target);
    if (information.isSymbolicLink() || !information.isFile()) {
      invalid(`generated output is not a regular file: ${basename(target)}`);
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function installGeneratedPair(staged) {
  const backups = [];
  const installed = [];
  try {
    for (const item of staged) {
      if (await existingGeneratedFile(item.target)) {
        const backup = join(
          dirname(item.target),
          `${basename(item.target)}.${process.pid}.${randomUUID()}.backup.tmp`,
        );
        await rename(item.target, backup);
        backups.push({ backup, target: item.target });
      }
    }
    for (const item of staged) {
      await rename(item.temporary, item.target);
      installed.push(item.target);
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const target of installed.reverse()) {
      await rm(target, { force: true }).catch((rollbackError) =>
        rollbackFailures.push(rollbackError),
      );
    }
    for (const item of backups.reverse()) {
      await rename(item.backup, item.target).catch((rollbackError) =>
        rollbackFailures.push(rollbackError),
      );
    }
    if (rollbackFailures.length > 0) {
      invalid("seal failed and previous generated files could not be fully restored", {
        cause: error,
      });
    }
    throw error;
  }

  await Promise.all(
    backups.map(({ backup }) => rm(backup, { force: true }).catch(() => undefined)),
  );
}

function checksumTextFor(manifestText, artifacts) {
  const entries = [
    { path: MANIFEST_NAME, sha256: createHash("sha256").update(manifestText).digest("hex") },
    ...artifacts.map(({ path, sha256 }) => ({ path, sha256 })),
  ].sort((left, right) => directCodePointCompare(left.path, right.path));
  return {
    entries,
    text: `${entries.map(({ path, sha256 }) => `${sha256}  ${path}`).join("\n")}\n`,
  };
}

function parseChecksums(text) {
  if (text.includes("\r")) invalid("malformed checksum line");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    invalid("SHA256SUMS is empty");
  }
  if (lines.length > MAX_EVIDENCE_FILE_COUNT + 1) {
    invalid(`evidence file count limit exceeded (${MAX_EVIDENCE_FILE_COUNT})`);
  }

  const entries = [];
  const seen = new Set();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) invalid("malformed checksum line");
    const sha256 = match[1];
    if (!SHA256.test(sha256)) invalid("malformed checksum line");
    const relativePath = normalizeRelativePath(match[2], "checksum path");
    if (seen.has(relativePath)) {
      invalid(`duplicate checksum path: ${displayPath(relativePath)}`);
    }
    seen.add(relativePath);
    entries.push({ path: relativePath, sha256 });
  }
  return entries;
}

function validateManifestConsistency(manifest, artifactFiles, artifactInformation) {
  if (!Array.isArray(manifest.artifacts)) invalid("manifest artifacts must be an array");
  const paths = [];
  const metadataByPath = new Map();
  for (const metadata of manifest.artifacts) {
    if (!isPlainObject(metadata)) invalid("manifest artifact metadata must be an object");
    const relativePath = normalizeRelativePath(metadata.path, "manifest artifact path");
    if (metadataByPath.has(relativePath)) {
      invalid(`duplicate manifest artifact path: ${displayPath(relativePath)}`);
    }
    metadataByPath.set(relativePath, metadata);
    paths.push(relativePath);
  }
  if (paths.some((path, index) => path !== [...paths].sort(directCodePointCompare)[index])) {
    invalid("manifest artifact paths are not deterministically sorted");
  }
  if (
    paths.length !== artifactFiles.length ||
    paths.some((path, index) => path !== artifactFiles[index])
  ) {
    invalid("manifest artifact list is inconsistent with package files");
  }

  for (const relativePath of artifactFiles) {
    const metadata = metadataByPath.get(relativePath);
    const actual = artifactInformation.get(relativePath);
    if (
      metadata.category !== relativePath.split("/", 1)[0] ||
      metadata.byteSize !== actual.byteSize ||
      metadata.sha256 !== actual.sha256
    ) {
      invalid(`manifest metadata mismatch: ${displayPath(relativePath)}`);
    }
  }
}

export async function listEvidenceFiles(root) {
  return enumerateRegularFiles(await resolveExistingRoot(root));
}

export async function sha256File(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) invalid("file path is required");
  const absolute = resolve(filePath);
  const information = await lstat(absolute);
  if (information.isSymbolicLink()) invalid("symlink files cannot be hashed");
  if (!information.isFile()) invalid("path is not a regular file");
  return (await hashOpenFile(await realpath(absolute))).sha256;
}

export async function buildManifest(root, draft) {
  return buildManifestAtRoot(await resolveExistingRoot(root), draft);
}

export async function sealEvidencePackage(root) {
  const resolvedRoot = await resolveExistingRoot(root);
  const draftText = await readBoundedUtf8(
    resolvedRoot,
    MANIFEST_NAME,
    MAX_MANIFEST_BYTES,
    "manifest",
    "manifest.json is missing",
  );
  const draft = parseManifest(draftText);
  const manifest = await buildManifestAtRoot(resolvedRoot, draft);
  const manifestText = serializeManifest(manifest);
  const checksums = checksumTextFor(manifestText, manifest.artifacts);
  if (Buffer.byteLength(checksums.text) > MAX_CHECKSUM_BYTES) {
    invalid("SHA256SUMS size limit exceeded");
  }

  const confirmation = serializeManifest(await buildManifestAtRoot(resolvedRoot, draft));
  if (confirmation !== manifestText) invalid("artifacts changed while sealing");

  const targets = [
    { target: join(resolvedRoot, MANIFEST_NAME), contents: manifestText },
    { target: join(resolvedRoot, CHECKSUMS_NAME), contents: checksums.text },
  ];
  const staged = [];
  try {
    for (const item of targets) {
      staged.push({
        target: item.target,
        temporary: await writeSiblingTemporary(item.target, item.contents),
      });
    }
    await installGeneratedPair(staged);
  } finally {
    await Promise.all(
      staged.map(({ temporary }) => rm(temporary, { force: true }).catch(() => undefined)),
    );
  }

  return { artifactCount: manifest.artifacts.length, checksumCount: checksums.entries.length };
}

export async function verifyEvidencePackage(root) {
  const resolvedRoot = await resolveExistingRoot(root);
  const checksumText = await readBoundedUtf8(
    resolvedRoot,
    CHECKSUMS_NAME,
    MAX_CHECKSUM_BYTES,
    "SHA256SUMS",
    "SHA256SUMS is missing",
  );
  const checksumEntries = parseChecksums(checksumText);
  const checksumByPath = new Map(checksumEntries.map((entry) => [entry.path, entry.sha256]));
  const actualFiles = await enumerateRegularFiles(resolvedRoot, { includeManifest: true });
  const actualSet = new Set(actualFiles);

  for (const { path } of checksumEntries) {
    if (!actualSet.has(path)) invalid(`missing checksummed file: ${displayPath(path)}`);
  }
  for (const relativePath of actualFiles) {
    if (!checksumByPath.has(relativePath)) {
      invalid(`unlisted regular file: ${displayPath(relativePath)}`);
    }
  }

  const artifactInformation = new Map();
  for (const relativePath of actualFiles) {
    const information = await inspectArtifact(
      resolvedRoot,
      relativePath,
      `missing checksummed file: ${displayPath(relativePath)}`,
    );
    if (information.sha256 !== checksumByPath.get(relativePath)) {
      invalid(`checksum mismatch: ${displayPath(relativePath)}`);
    }
    if (relativePath !== MANIFEST_NAME) artifactInformation.set(relativePath, information);
  }

  const manifestText = await readBoundedUtf8(
    resolvedRoot,
    MANIFEST_NAME,
    MAX_MANIFEST_BYTES,
    "manifest",
    "manifest.json is missing",
  );
  const manifest = parseManifest(manifestText);
  validateManifestConsistency(
    manifest,
    actualFiles.filter((relativePath) => relativePath !== MANIFEST_NAME),
    artifactInformation,
  );
  return { checkedCount: checksumEntries.length };
}
