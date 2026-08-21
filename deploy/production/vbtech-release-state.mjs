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
const LOCK_KEYS = "owner,pid";
const CLAIM_KEYS = "generation,kind,record";
const TEMPORARY_FILE_PATTERN =
  /^\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{40}-[0-9a-f]{64}\.(?:pending|healthy|failed)\.json\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/;
const LOCK_TEMPORARY_FILE_PATTERN =
  /^\.vbtech-release-state\.lock\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/;
const CLAIM_TEMPORARY_FILE_PATTERN =
  /^\.vbtech-release-state\.[0-9a-f]{40}-[0-9a-f]{64}\.(?:pending|terminal)-[1-9][0-9]*\.claim\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/;

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

function sameRecord(left, right) {
  return sameIdentity(left, right) && left.state === right.state;
}

function recordIdentity(value) {
  return `${value.createdAt}\n${value.releaseSha}\n${value.imageDigest}`;
}

function releaseIdentity(value) {
  return `${value.releaseSha}\n${value.imageDigest}`;
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

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isLifecycleLock(value) {
  return (
    hasExactKeys(value, LOCK_KEYS) &&
    isUuid(value.owner) &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0
  );
}

function isLifecycleClaim(value) {
  return (
    hasExactKeys(value, CLAIM_KEYS) &&
    typeof value.kind === "string" &&
    (value.kind === "pending" || value.kind === "terminal") &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    isLifecycleRecord(value.record) &&
    ((value.kind === "pending" && value.record.state === "pending") ||
      (value.kind === "terminal" &&
        (value.record.state === "healthy" || value.record.state === "failed")))
  );
}

function claimFileName(value) {
  const identity = `${value.record.releaseSha}-${value.record.imageDigest.slice(7)}`;
  return `.vbtech-release-state.${identity}.${value.kind}-${value.generation}.claim`;
}

function sameClaimIdentity(left, right) {
  return sameIdentity(left.record, right.record);
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

async function syncDirectory(directory) {
  let directoryHandle;
  try {
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
  } finally {
    await directoryHandle?.close();
  }
}

async function readLifecycleLock(directory, createError) {
  const path = join(directory, LOCK_FILE);
  let linkMetadata;
  let metadata;
  let contents;
  try {
    linkMetadata = await lstat(path);
    metadata = await stat(path);
    if (
      !linkMetadata.isFile() ||
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      metadata.size > MAX_RECORD_BYTES
    )
      throw createError();
    contents = await readFile(path, "utf8");
  } catch {
    throw createError();
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw createError();
  }
  if (!isLifecycleLock(value)) throw createError();
  return value;
}

async function readLifecycleClaim(directory, file, createError) {
  const path = join(directory, file);
  let linkMetadata;
  let metadata;
  let contents;
  try {
    linkMetadata = await lstat(path);
    metadata = await stat(path);
    if (
      !linkMetadata.isFile() ||
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      metadata.size > MAX_RECORD_BYTES
    )
      throw createError();
    contents = await readFile(path, "utf8");
  } catch {
    throw createError();
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw createError();
  }
  if (!isLifecycleClaim(value) || file !== claimFileName(value)) throw createError();
  return value;
}

async function assertAllowedTransientEntry(directory, file) {
  if (file === LOCK_FILE) {
    await readLifecycleLock(directory, stateError);
    return;
  }
  if (file.endsWith(".claim")) return readLifecycleClaim(directory, file, stateError);

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
  if (
    (!TEMPORARY_FILE_PATTERN.test(file) &&
      !LOCK_TEMPORARY_FILE_PATTERN.test(file) &&
      !CLAIM_TEMPORARY_FILE_PATTERN.test(file)) ||
    metadata.size > MAX_RECORD_BYTES
  )
    throw stateError();
}

function sameClaimRecord(claim, record) {
  return sameRecord(claim.record, record);
}

function validatedClaimChains(claims) {
  const claimsByRelease = new Map();
  for (const claim of claims) {
    const identity = releaseIdentity(claim.record);
    const values = claimsByRelease.get(identity) ?? [];
    values.push(claim);
    claimsByRelease.set(identity, values);
  }

  const chains = new Map();
  for (const [identity, releaseClaims] of claimsByRelease) {
    const pendingByGeneration = new Map();
    const terminalByGeneration = new Map();
    for (const claim of releaseClaims) {
      const claimsByGeneration =
        claim.kind === "pending" ? pendingByGeneration : terminalByGeneration;
      if (claimsByGeneration.has(claim.generation)) throw stateError();
      claimsByGeneration.set(claim.generation, claim);
    }

    const generations = [...pendingByGeneration.keys()].sort((left, right) => left - right);
    if (generations.length === 0) throw stateError();
    for (let index = 0; index < generations.length; index += 1) {
      if (generations[index] !== index + 1) throw stateError();
    }
    for (const generation of terminalByGeneration.keys()) {
      if (!pendingByGeneration.has(generation)) throw stateError();
    }

    const chain = generations.map((generation) => ({
      generation,
      pendingClaim: pendingByGeneration.get(generation),
      terminalClaim: terminalByGeneration.get(generation),
    }));
    for (let index = 0; index < chain.length; index += 1) {
      const current = chain[index];
      if (
        current.terminalClaim !== undefined &&
        !sameClaimIdentity(current.pendingClaim, current.terminalClaim)
      )
        throw stateError();
      if (index > 0 && chain[index - 1].terminalClaim?.record.state !== "failed")
        throw stateError();
    }
    chains.set(identity, chain);
  }
  return chains;
}

function assertClaimConsistency(records, claims) {
  const chains = validatedClaimChains(claims);
  const pendingClaims = claims.filter((claim) => claim.kind === "pending");
  const terminalClaims = claims.filter((claim) => claim.kind === "terminal");
  for (const pendingClaim of pendingClaims) {
    const matches = records.filter(
      (record) => record.state === "pending" && sameClaimRecord(pendingClaim, record),
    );
    if (matches.length > 1) throw stateError();
  }
  for (const terminalClaim of terminalClaims) {
    const pending = pendingClaims.filter(
      (claim) =>
        claim.generation === terminalClaim.generation && sameClaimIdentity(claim, terminalClaim),
    );
    const terminals = records.filter(
      (record) => record.state !== "pending" && sameClaimRecord(terminalClaim, record),
    );
    if (pending.length !== 1 || terminals.length > 1) throw stateError();
  }
  for (const pending of records.filter((record) => record.state === "pending")) {
    if (pendingClaims.filter((claim) => sameClaimRecord(claim, pending)).length !== 1)
      throw stateError();
  }
  for (const terminal of records.filter((record) => record.state !== "pending")) {
    const matchingPending = pendingClaims.filter((claim) => sameIdentity(claim.record, terminal));
    const matchingTerminal = terminalClaims.filter((claim) => sameClaimRecord(claim, terminal));
    if (matchingPending.length !== 1 || matchingTerminal.length !== 1) throw stateError();
  }
  return { chains, logicalRecords: claims.map((claim) => claim.record) };
}

async function readReleaseState(directory) {
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
  const claims = [];
  const records = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) {
      const claim = await assertAllowedTransientEntry(directory, file);
      if (claim) claims.push(claim);
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
  const { chains, logicalRecords } = assertClaimConsistency(records, claims);
  assertRecordTransitions(logicalRecords);
  return { chains, claims, persistedRecords: records, records: logicalRecords };
}

async function readReleaseRecords(directory) {
  const state = await readReleaseState(directory);
  return state?.records;
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

function boundedJson(value, createError) {
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_RECORD_BYTES) throw createError();
  return contents;
}

function boundedRecordJson(value) {
  return boundedJson(value, transitionError);
}

function claimTemporaryFileName(value, uuid) {
  return `${claimFileName(value)}.${uuid}.tmp`;
}

async function publishLifecycleClaim(directory, value) {
  const temporaryUuid = nodeRandomUUID();
  if (!isUuid(temporaryUuid)) throw transitionError();
  const destination = join(directory, claimFileName(value));
  const temporary = join(directory, claimTemporaryFileName(value, temporaryUuid));
  let file;
  let temporaryExists = true;
  try {
    file = await open(temporary, "wx", PRIVATE_FILE_MODE);
    await file.chmod(PRIVATE_FILE_MODE);
    await file.writeFile(boundedJson(value, transitionError), "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await link(temporary, destination);
    await syncDirectory(directory);
    await unlink(temporary);
    temporaryExists = false;
    await syncDirectory(directory);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw transitionError();
  } finally {
    await file?.close().catch(() => undefined);
    if (temporaryExists)
      await unlink(temporary)
        .then(() => syncDirectory(directory))
        .catch(() => undefined);
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
  if (!isUuid(uuid)) throw transitionError();

  await ensurePrivateDirectory(directory);
  const destination = join(directory, recordFileName(value));
  const temporary = join(directory, `.${recordFileName(value)}.${uuid}.tmp`);
  let file;
  let temporaryExists = true;
  try {
    file = await open(temporary, "wx", PRIVATE_FILE_MODE);
    await file.chmod(PRIVATE_FILE_MODE);
    await file.writeFile(boundedRecordJson(value), "utf8");
    await file.sync();
    await file.close();
    file = undefined;

    await link(temporary, destination);
    await syncDirectory(directory);

    await unlink(temporary);
    temporaryExists = false;
    await syncDirectory(directory);
  } catch (error) {
    throw transitionError();
  } finally {
    await file?.close().catch(() => undefined);
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
  }
  return value;
}

async function pendingForTransition(directory, pending) {
  if (!isLifecycleRecord(pending) || pending.state !== "pending") throw transitionError();
  const state = await readReleaseState(directory);
  if (state === undefined) throw transitionError();

  const persisted = state.records.filter(
    (value) => value.state === "pending" && sameIdentity(value, pending),
  );
  const terminals = state.records.filter(
    (value) => value.state !== "pending" && sameIdentity(value, pending),
  );
  const pendingClaims = state.claims.filter(
    (claim) => claim.kind === "pending" && sameClaimRecord(claim, pending),
  );
  const terminalClaims = state.claims.filter(
    (claim) => claim.kind === "terminal" && sameIdentity(claim.record, pending),
  );
  if (
    persisted.length !== 1 ||
    pendingClaims.length !== 1 ||
    terminals.length > 1 ||
    terminalClaims.length !== terminals.length
  )
    throw transitionError();
  const terminalClaim = terminalClaims[0];
  const terminalPersisted =
    terminalClaim !== undefined &&
    state.persistedRecords.some((record) => sameClaimRecord(terminalClaim, record));
  return {
    generation: pendingClaims[0].generation,
    record: persisted[0],
    terminalClaim,
    terminalPersisted,
  };
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
  const state = await readReleaseState(directory);
  const records = state?.records ?? [];
  const chain = state?.chains.get(releaseIdentity(validatedSelector));
  const previousGeneration = chain?.[chain.length - 1];
  if (
    previousGeneration !== undefined &&
    previousGeneration.terminalClaim?.record.state !== "failed"
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

  const generation = (previousGeneration?.generation ?? 0) + 1;
  const pending = {
    releaseSha: validatedSelector.releaseSha,
    imageRef: validatedSelector.imageRef,
    imageDigest: validatedSelector.imageDigest,
    submissionState: validatedSelector.submissionState,
    createdAt,
    state: "pending",
  };
  if (records.some((value) => recordFileName(value) === recordFileName(pending)))
    throw transitionError();
  const claim = {
    kind: "pending",
    generation,
    record: pending,
  };
  await ensurePrivateDirectory(directory);
  if (!(await publishLifecycleClaim(directory, claim))) throw transitionError();
  return publishRecord(directory, pending, supplied);
}

export async function markVbtechReleaseHealthy(directory, pending, supplied = {}) {
  const persisted = await pendingForTransition(directory, pending);
  const healthy = { ...persisted.record, state: "healthy" };
  if (persisted.terminalClaim !== undefined) {
    if (!sameClaimRecord(persisted.terminalClaim, healthy) || persisted.terminalPersisted)
      throw transitionError();
    return publishRecord(directory, healthy, supplied);
  }
  const claim = {
    kind: "terminal",
    generation: persisted.generation,
    record: healthy,
  };
  if (!(await publishLifecycleClaim(directory, claim))) throw transitionError();
  return publishRecord(directory, healthy, supplied);
}

export async function markVbtechReleaseFailed(directory, pending, supplied = {}) {
  const persisted = await pendingForTransition(directory, pending);
  const failed = { ...persisted.record, state: "failed" };
  if (persisted.terminalClaim !== undefined) {
    if (!sameClaimRecord(persisted.terminalClaim, failed) || persisted.terminalPersisted)
      throw transitionError();
    return publishRecord(directory, failed, supplied);
  }
  const claim = {
    kind: "terminal",
    generation: persisted.generation,
    record: failed,
  };
  if (!(await publishLifecycleClaim(directory, claim))) throw transitionError();
  return publishRecord(directory, failed, supplied);
}
