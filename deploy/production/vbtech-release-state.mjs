import { link, lstat, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { randomUUID as nodeRandomUUID } from "node:crypto";
import { join } from "node:path";

const MAX_RECORD_BYTES = 16 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REPOSITORY = "ghcr.io/thevladbog/vbtech-web";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SELECTOR_KEYS = "functionPath,imageDigest,imageRef,releaseSha,submissionState";
const RECORD_KEYS = "createdAt,imageDigest,imageRef,releaseSha,state,submissionState";
const LOCK_FILE = ".vbtech-release-state.lock";
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5 * 1000;
const TEMPORARY_FILE_PATTERN =
  /^\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{40}-[0-9a-f]{64}\.(?:pending|healthy|failed)\.json\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/;

function selectorError() {
  return new Error("v-b release selector is invalid");
}

function stateError() {
  return new Error("v-b release state is invalid");
}

function transitionError() {
  return new Error("v-b release transition rejected");
}

function hasExactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys
  );
}

function isCanonicalIsoDate(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isImageIdentity(value) {
  return (
    typeof value.releaseSha === "string" &&
    RELEASE_SHA_PATTERN.test(value.releaseSha) &&
    typeof value.imageDigest === "string" &&
    DIGEST_PATTERN.test(value.imageDigest) &&
    typeof value.imageRef === "string" &&
    value.imageRef === `${REPOSITORY}@${value.imageDigest}`
  );
}

function sameIdentity(left, right) {
  return (
    left.releaseSha === right.releaseSha &&
    left.imageRef === right.imageRef &&
    left.imageDigest === right.imageDigest &&
    left.submissionState === right.submissionState &&
    left.createdAt === right.createdAt
  );
}

function recordIdentity(value) {
  return `${value.createdAt}\n${value.releaseSha}\n${value.imageDigest}`;
}

function recordFileName(value) {
  return `${value.createdAt.replace(/[:.]/g, "-")}-${value.releaseSha}-${value.imageDigest.slice(7)}.${value.state}.json`;
}

function isLifecycleRecord(value) {
  return (
    hasExactKeys(value, RECORD_KEYS) &&
    isImageIdentity(value) &&
    value.submissionState === "disabled" &&
    isCanonicalIsoDate(value.createdAt) &&
    (value.state === "pending" || value.state === "healthy" || value.state === "failed")
  );
}

function assertRecordTransitions(records) {
  const pending = new Map();
  const terminals = new Map();

  for (const value of records) {
    const identity = recordIdentity(value);
    if (value.state === "pending") {
      if (pending.has(identity)) throw stateError();
      pending.set(identity, value);
      continue;
    }
    const values = terminals.get(identity) ?? [];
    values.push(value);
    terminals.set(identity, values);
  }

  for (const [identity, values] of terminals) {
    if (!pending.has(identity) || values.length !== 1) throw stateError();
  }
}

function dependencies(supplied = {}) {
  return {
    now: () => new Date(),
    randomUUID: nodeRandomUUID,
    ...supplied,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function syncDirectory(directory) {
  let directoryHandle;
  try {
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
  } finally {
    await directoryHandle?.close();
  }
}

async function assertAllowedTransientEntry(directory, file) {
  const path = join(directory, file);
  let linkMetadata;
  let metadata;
  try {
    linkMetadata = await lstat(path);
    metadata = await stat(path);
  } catch {
    throw stateError();
  }
  if (!linkMetadata.isFile() || !metadata.isFile() || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE)
    throw stateError();
  if (file === LOCK_FILE) {
    if (metadata.size !== 0) throw stateError();
    return;
  }
  if (!TEMPORARY_FILE_PATTERN.test(file) || metadata.size > MAX_RECORD_BYTES) throw stateError();
}

async function readReleaseRecords(directory) {
  let directoryLinkMetadata;
  let directoryMetadata;
  try {
    directoryLinkMetadata = await lstat(directory);
    directoryMetadata = await stat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw stateError();
  }
  if (
    !directoryLinkMetadata.isDirectory() ||
    !directoryMetadata.isDirectory() ||
    (directoryMetadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  )
    throw stateError();

  let files;
  try {
    files = await readdir(directory);
  } catch {
    throw stateError();
  }
  const records = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) {
      await assertAllowedTransientEntry(directory, file);
      continue;
    }
    const path = join(directory, file);
    let metadata;
    let contents;
    try {
      const linkMetadata = await lstat(path);
      metadata = await stat(path);
      if (
        !linkMetadata.isFile() ||
        !metadata.isFile() ||
        (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
        metadata.size > MAX_RECORD_BYTES
      )
        throw stateError();
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (error?.message === "v-b release state is invalid") throw error;
      throw stateError();
    }

    let value;
    try {
      value = JSON.parse(contents);
    } catch {
      throw stateError();
    }
    if (!isLifecycleRecord(value) || file !== recordFileName(value)) throw stateError();
    records.push(value);
  }
  assertRecordTransitions(records);
  return records;
}

async function ensurePrivateDirectory(directory) {
  let linkMetadata;
  let metadata;
  try {
    linkMetadata = await lstat(directory);
    metadata = await stat(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw transitionError();
    try {
      await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      linkMetadata = await lstat(directory);
      metadata = await stat(directory);
    } catch {
      throw transitionError();
    }
  }
  if (
    !linkMetadata.isDirectory() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  )
    throw transitionError();
}

function boundedRecordJson(value) {
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_RECORD_BYTES) throw transitionError();
  return contents;
}

async function inspectLifecycleLock(directory) {
  const path = join(directory, LOCK_FILE);
  let linkMetadata;
  let metadata;
  try {
    linkMetadata = await lstat(path);
    metadata = await stat(path);
  } catch {
    throw transitionError();
  }
  if (
    !linkMetadata.isFile() ||
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
    metadata.size !== 0
  )
    throw transitionError();
  return metadata;
}

async function acquireLifecycleLock(directory) {
  await ensurePrivateDirectory(directory);
  const path = join(directory, LOCK_FILE);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    let file;
    try {
      file = await open(path, "wx", PRIVATE_FILE_MODE);
      await file.chmod(PRIVATE_FILE_MODE);
      await file.sync();
      await file.close();
      file = undefined;
      await syncDirectory(directory);
      return;
    } catch (error) {
      await file?.close().catch(() => undefined);
      if (error?.code !== "EEXIST") throw transitionError();
    }

    const metadata = await inspectLifecycleLock(directory);
    if (Date.now() - metadata.mtimeMs >= LOCK_STALE_MS) {
      try {
        await unlink(path);
        await syncDirectory(directory);
      } catch {
        throw transitionError();
      }
      continue;
    }
    if (Date.now() >= deadline) throw transitionError();
    await sleep(LOCK_RETRY_MS);
  }
}

async function releaseLifecycleLock(directory) {
  const path = join(directory, LOCK_FILE);
  try {
    await inspectLifecycleLock(directory);
    await unlink(path);
    await syncDirectory(directory);
  } catch {
    throw transitionError();
  }
}

async function withLifecycleLock(directory, operation) {
  await acquireLifecycleLock(directory);
  try {
    return await operation();
  } finally {
    await releaseLifecycleLock(directory);
  }
}

async function publishRecord(directory, value, supplied) {
  const { randomUUID } = dependencies(supplied);
  let uuid;
  try {
    uuid = randomUUID();
  } catch {
    throw transitionError();
  }
  if (typeof uuid !== "string" || !UUID_PATTERN.test(uuid)) throw transitionError();

  await ensurePrivateDirectory(directory);
  const destination = join(directory, recordFileName(value));
  const temporary = join(directory, `.${recordFileName(value)}.${uuid}.tmp`);
  let file;
  let directoryHandle;
  let temporaryExists = true;
  try {
    file = await open(temporary, "wx", PRIVATE_FILE_MODE);
    await file.chmod(PRIVATE_FILE_MODE);
    await file.writeFile(boundedRecordJson(value), "utf8");
    await file.sync();
    await file.close();
    file = undefined;

    await link(temporary, destination);
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;

    await unlink(temporary);
    temporaryExists = false;
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
  } catch {
    throw transitionError();
  } finally {
    await file?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
  }
  return value;
}

async function pendingForTransition(directory, pending) {
  if (!isLifecycleRecord(pending) || pending.state !== "pending") throw transitionError();
  const records = await readReleaseRecords(directory);
  if (records === undefined) throw transitionError();

  const persisted = records.filter(
    (value) => value.state === "pending" && sameIdentity(value, pending),
  );
  const terminals = records.filter(
    (value) => value.state !== "pending" && sameIdentity(value, pending),
  );
  if (persisted.length !== 1 || terminals.length !== 0) throw transitionError();
  return persisted[0];
}

export function validateVbtechSelector(value) {
  try {
    if (
      !hasExactKeys(value, SELECTOR_KEYS) ||
      !isImageIdentity(value) ||
      value.functionPath !== "" ||
      value.submissionState !== "disabled"
    )
      throw selectorError();
  } catch (error) {
    if (error?.message === "v-b release selector is invalid") throw error;
    throw selectorError();
  }
  return { ...value };
}

export async function latestHealthyVbtechRelease(directory) {
  const records = await readReleaseRecords(directory);
  if (records === undefined) return undefined;

  const failed = records.filter((value) => value.state === "failed");
  const healthy = records.filter(
    (value) =>
      value.state === "healthy" && !failed.some((terminal) => sameIdentity(terminal, value)),
  );
  if (healthy.length === 0) return undefined;

  healthy.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (healthy.length > 1 && healthy[0].createdAt === healthy[1].createdAt) throw stateError();
  return { ...healthy[0] };
}

export async function writePendingVbtechRelease(directory, selector, supplied = {}) {
  const validatedSelector = validateVbtechSelector(selector);
  return withLifecycleLock(directory, async () => {
    const records = await readReleaseRecords(directory);
    if (
      records?.some(
        (value) =>
          (value.state === "pending" || value.state === "healthy") &&
          value.releaseSha === validatedSelector.releaseSha &&
          value.imageDigest === validatedSelector.imageDigest,
      )
    )
      throw transitionError();

    let createdAt;
    try {
      const date = dependencies(supplied).now();
      createdAt = date.toISOString();
    } catch {
      throw transitionError();
    }
    if (!isCanonicalIsoDate(createdAt)) throw transitionError();

    return publishRecord(
      directory,
      {
        releaseSha: validatedSelector.releaseSha,
        imageRef: validatedSelector.imageRef,
        imageDigest: validatedSelector.imageDigest,
        submissionState: validatedSelector.submissionState,
        createdAt,
        state: "pending",
      },
      supplied,
    );
  });
}

export async function markVbtechReleaseHealthy(directory, pending, supplied = {}) {
  return withLifecycleLock(directory, async () => {
    const persisted = await pendingForTransition(directory, pending);
    return publishRecord(directory, { ...persisted, state: "healthy" }, supplied);
  });
}

export async function markVbtechReleaseFailed(directory, pending, supplied = {}) {
  return withLifecycleLock(directory, async () => {
    const persisted = await pendingForTransition(directory, pending);
    return publishRecord(directory, { ...persisted, state: "failed" }, supplied);
  });
}
