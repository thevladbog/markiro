import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

import {
  assertEvidenceRootStable,
  assertOwnedRegularPath,
  bindEvidenceRoot,
  closeEvidenceRoot,
  EvidencePackageError,
  hashBoundRegularFile,
  invalid,
  lstatBoundPath,
  readBoundDirectory,
  readBoundRegularFile,
  removeOwnedRegularPath,
  renameOwnedRegularPath,
} from "./secure-filesystem.mjs";

export { EvidencePackageError } from "./secure-filesystem.mjs";

export const MAX_EVIDENCE_FILE_COUNT = 10_000;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const MAX_RELATIVE_PATH_BYTES = 4096;
const MAX_CHECKSUM_BYTES = 48 * 1024 * 1024;
const MANIFEST_NAME = "manifest.json";
const CHECKSUMS_NAME = "SHA256SUMS";
const SHA256 = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^INV-\d{8}-[a-z0-9-]{2,40}-\d{2}$/;
const directCodePointCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defineOwn(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function normalizeJson(value, context = "manifest") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, context));
  if (!isPlainObject(value)) invalid(`${context} contains a non-JSON value`);

  const normalized = {};
  for (const key of Object.keys(value).sort(directCodePointCompare)) {
    if (value[key] === undefined) invalid(`${context} contains an undefined value`);
    defineOwn(normalized, key, normalizeJson(value[key], context));
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

function shouldExclude(relativePath, includeManifest) {
  if (relativePath === CHECKSUMS_NAME) return true;
  if (!includeManifest && relativePath === MANIFEST_NAME) return true;
  return basename(relativePath).endsWith(".tmp");
}

async function enumerateRegularFiles(session, { includeManifest = false } = {}) {
  const files = [];
  const directories = [{ identity: session.rootIdentity, relative: "" }];

  while (directories.length > 0) {
    const directory = directories.pop();
    const { entries } = await readBoundDirectory(session, directory.relative, directory.identity);
    entries.sort((left, right) => directCodePointCompare(left.name, right.name));

    for (const entry of entries) {
      const relativePath = normalizeRelativePath(
        directory.relative ? `${directory.relative}/${entry.name}` : entry.name,
      );
      const information = await lstatBoundPath(session, relativePath);
      if (information.isDirectory()) {
        directories.push({ identity: information, relative: relativePath });
      } else if (information.isFile()) {
        if (!shouldExclude(relativePath, includeManifest)) {
          files.push({ identity: information, path: relativePath });
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

  return files.sort((left, right) => directCodePointCompare(left.path, right.path));
}

async function readBoundedBytes(session, relativePath, limit, sizeLabel, expected) {
  try {
    return await readBoundRegularFile(session, relativePath, { expected, maxBytes: limit });
  } catch (error) {
    if (error instanceof EvidencePackageError && error.message === "file size limit exceeded") {
      invalid(`${sizeLabel} size limit exceeded`, { cause: error });
    }
    if (error?.code === "ENOENT") invalid(`${relativePath} is missing`, { cause: error });
    throw error;
  }
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
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

async function buildManifestInSession(session, draft) {
  if (!isPlainObject(draft)) invalid("manifest draft must be an object");
  if (!OPERATION_ID.test(draft.operationId)) invalid("manifest has an invalid operation id");
  if (draft.artifacts !== undefined && !Array.isArray(draft.artifacts)) {
    invalid("manifest artifacts must be an array");
  }

  const priorByPath = priorArtifactsByPath(draft);
  const files = await enumerateRegularFiles(session);
  const artifacts = [];
  for (const file of files) {
    const { byteSize, sha256 } = await hashBoundRegularFile(session, file.path, {
      expected: file.identity,
    });
    const prior = priorByPath.get(file.path);
    const physicalBoxRefs = prior?.physicalBoxRefs ?? [];
    const evidenceRefs = prior?.evidenceRefs ?? [];
    if (!Array.isArray(physicalBoxRefs) || !Array.isArray(evidenceRefs)) {
      invalid(`manifest references must be arrays: ${displayPath(file.path)}`);
    }
    artifacts.push({
      path: file.path,
      category: file.path.split("/", 1)[0],
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
    defineOwn(normalized, key, normalizeJson(draft[key]));
  }
  defineOwn(normalized, "artifacts", artifacts);
  return normalized;
}

function serializeManifest(manifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) invalid("manifest size limit exceeded");
  return text;
}

async function writeSiblingTemporary(session, targetRelativePath, contents) {
  const temporaryRelativePath = `${targetRelativePath}.${process.pid}.${randomUUID()}.tmp`;
  const temporary = join(session.rootPath, ...temporaryRelativePath.split("/"));
  let handle;
  let ownership;
  try {
    await assertEvidenceRootStable(session);
    handle = await session.filesystem.open(temporary, "wx", 0o600);
    ownership = {
      identity: await handle.stat({ bigint: true }),
      relativePath: temporaryRelativePath,
    };
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    ownership.identity = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
    await assertOwnedRegularPath(session, ownership);
    return ownership;
  } catch (error) {
    const cleanupFailures = [];
    await handle?.close().catch((cleanupError) => cleanupFailures.push(cleanupError));
    if (ownership) {
      await removeOwnedRegularPath(session, ownership).catch((cleanupError) =>
        cleanupFailures.push(cleanupError),
      );
    }
    if (cleanupFailures.length > 0) {
      invalid("temporary output cleanup failed; manual recovery is required", {
        cause: cleanupFailures[0],
      });
    }
    throw error;
  }
}

async function existingGeneratedFile(session, relativePath) {
  try {
    const information = await lstatBoundPath(session, relativePath);
    if (!information.isFile()) invalid(`generated output is not a regular file: ${relativePath}`);
    return { identity: information, relativePath };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function transactionFailureMessage(failure) {
  if (failure.phase === "backup") return `generated output backup failed: ${failure.item.path}`;
  return `generated output install failed: ${failure.item.path}`;
}

async function installGeneratedPair(session, staged) {
  const backups = [];
  const installed = [];
  let failure;

  for (const item of staged) {
    const ownership = await existingGeneratedFile(session, item.path);
    if (!ownership) continue;
    const backupRelativePath = `${item.path}.${process.pid}.${randomUUID()}.backup.tmp`;
    const record = { item, ownership };
    try {
      await renameOwnedRegularPath(session, ownership, backupRelativePath, () => {
        backups.push(record);
      });
    } catch (error) {
      failure = { error, item, phase: "backup" };
      break;
    }
  }

  if (!failure) {
    for (const item of staged) {
      const record = { item, ownership: item.temporary };
      try {
        await renameOwnedRegularPath(session, item.temporary, item.path, () => {
          item.state = "installed";
          installed.push(record);
        });
      } catch (error) {
        failure = { error, item, phase: "install" };
        break;
      }
    }
  }

  if (failure) {
    const rollbackFailures = [];
    for (const record of [...installed].reverse()) {
      try {
        await removeOwnedRegularPath(session, record.ownership);
        record.item.state = "removed";
      } catch (error) {
        rollbackFailures.push(error);
      }
    }
    for (const record of [...backups].reverse()) {
      try {
        await renameOwnedRegularPath(session, record.ownership, record.item.path);
      } catch (error) {
        rollbackFailures.push(error);
      }
    }
    if (rollbackFailures.length > 0) {
      invalid(
        "generated output ownership changed or rollback was incomplete; manual recovery from sibling .tmp files is required",
        { cause: failure.error },
      );
    }
    invalid(transactionFailureMessage(failure), { cause: failure.error });
  }

  const cleanupFailures = [];
  for (const record of backups) {
    await removeOwnedRegularPath(session, record.ownership).catch((error) =>
      cleanupFailures.push(error),
    );
  }
  if (cleanupFailures.length > 0) {
    invalid("backup cleanup failed after an ownership change; manual recovery is required", {
      cause: cleanupFailures[0],
    });
  }
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

function parseChecksums(bytes) {
  const text = bytes.toString("utf8");
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
    if (!match || !SHA256.test(match[1])) invalid("malformed checksum line");
    const relativePath = normalizeRelativePath(match[2], "checksum path");
    if (seen.has(relativePath)) {
      invalid(`duplicate checksum path: ${displayPath(relativePath)}`);
    }
    seen.add(relativePath);
    entries.push({ path: relativePath, sha256: match[1] });
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
  const sorted = [...paths].sort(directCodePointCompare);
  if (paths.some((path, index) => path !== sorted[index])) {
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

async function withEvidenceRoot(root, options, action) {
  const session = await bindEvidenceRoot(root, options);
  let operationError;
  let result;
  try {
    result = await action(session);
  } catch (error) {
    operationError = error;
  }

  let stabilityError;
  try {
    await assertEvidenceRootStable(session);
  } catch (error) {
    stabilityError = error;
  }

  let closeError;
  try {
    await closeEvidenceRoot(session);
  } catch (error) {
    closeError = error;
  }

  if (closeError) invalid("filesystem descriptor cleanup failed", { cause: closeError });
  if (stabilityError) {
    invalid("filesystem identity changed: root; manual recovery is required", {
      cause: operationError ?? stabilityError,
    });
  }
  if (operationError) throw operationError;
  return result;
}

export async function listEvidenceFiles(root, options = {}) {
  return withEvidenceRoot(root, options, async (session) =>
    (await enumerateRegularFiles(session)).map(({ path }) => path),
  );
}

export async function sha256File(filePath, options = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) invalid("file path is required");
  const absolute = resolve(filePath);
  return withEvidenceRoot(
    dirname(absolute),
    options,
    async (session) => (await hashBoundRegularFile(session, basename(absolute))).sha256,
  );
}

export async function buildManifest(root, draft, options = {}) {
  return withEvidenceRoot(root, options, (session) => buildManifestInSession(session, draft));
}

export async function sealEvidencePackage(root, options = {}) {
  return withEvidenceRoot(root, options, async (session) => {
    const draftBytes = await readBoundedBytes(
      session,
      MANIFEST_NAME,
      MAX_MANIFEST_BYTES,
      "manifest",
    );
    const draft = parseManifest(draftBytes.bytes);
    const manifest = await buildManifestInSession(session, draft);
    const manifestText = serializeManifest(manifest);
    const checksums = checksumTextFor(manifestText, manifest.artifacts);
    if (Buffer.byteLength(checksums.text) > MAX_CHECKSUM_BYTES) {
      invalid("SHA256SUMS size limit exceeded");
    }

    const confirmation = serializeManifest(await buildManifestInSession(session, draft));
    if (confirmation !== manifestText) invalid("artifacts changed while sealing");

    const staged = [];
    let result;
    let transactionError;
    try {
      for (const item of [
        { contents: manifestText, path: MANIFEST_NAME },
        { contents: checksums.text, path: CHECKSUMS_NAME },
      ]) {
        staged.push({
          path: item.path,
          state: "staged",
          temporary: await writeSiblingTemporary(session, item.path, item.contents),
        });
      }
      await installGeneratedPair(session, staged);
      result = {
        artifactCount: manifest.artifacts.length,
        checksumCount: checksums.entries.length,
      };
    } catch (error) {
      transactionError = error;
    }

    const cleanupFailures = [];
    for (const item of staged) {
      if (item.state !== "staged") continue;
      await removeOwnedRegularPath(session, item.temporary).catch((error) =>
        cleanupFailures.push(error),
      );
    }
    if (transactionError && cleanupFailures.length > 0) {
      invalid("seal failed and temporary output cleanup also failed; manual recovery is required", {
        cause: transactionError,
      });
    }
    if (transactionError) throw transactionError;
    if (cleanupFailures.length > 0) {
      invalid("temporary output cleanup failed; manual recovery is required", {
        cause: cleanupFailures[0],
      });
    }
    return result;
  });
}

export async function verifyEvidencePackage(root, options = {}) {
  return withEvidenceRoot(root, options, async (session) => {
    const checksumFile = await readBoundedBytes(
      session,
      CHECKSUMS_NAME,
      MAX_CHECKSUM_BYTES,
      "SHA256SUMS",
    );
    const checksumEntries = parseChecksums(checksumFile.bytes);
    const checksumByPath = new Map(checksumEntries.map((entry) => [entry.path, entry.sha256]));
    const actualFiles = await enumerateRegularFiles(session, { includeManifest: true });
    const actualPaths = actualFiles.map(({ path }) => path);
    const actualSet = new Set(actualPaths);

    for (const { path } of checksumEntries) {
      if (!actualSet.has(path)) invalid(`missing checksummed file: ${displayPath(path)}`);
    }
    for (const relativePath of actualPaths) {
      if (!checksumByPath.has(relativePath)) {
        invalid(`unlisted regular file: ${displayPath(relativePath)}`);
      }
    }

    const artifactInformation = new Map();
    let manifestBytes;
    for (const file of actualFiles) {
      let information;
      if (file.path === MANIFEST_NAME) {
        const manifestFile = await readBoundedBytes(
          session,
          MANIFEST_NAME,
          MAX_MANIFEST_BYTES,
          "manifest",
          file.identity,
        );
        manifestBytes = manifestFile.bytes;
        information = {
          byteSize: manifestFile.byteSize,
          sha256: createHash("sha256").update(manifestBytes).digest("hex"),
        };
      } else {
        information = await hashBoundRegularFile(session, file.path, {
          expected: file.identity,
        });
        artifactInformation.set(file.path, information);
      }
      if (information.sha256 !== checksumByPath.get(file.path)) {
        invalid(`checksum mismatch: ${displayPath(file.path)}`);
      }
    }

    if (!manifestBytes) invalid("manifest.json is missing");
    const manifest = parseManifest(manifestBytes);
    validateManifestConsistency(
      manifest,
      actualPaths.filter((relativePath) => relativePath !== MANIFEST_NAME),
      artifactInformation,
    );
    return { checkedCount: checksumEntries.length };
  });
}
