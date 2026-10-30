import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createPlatformManifest } from "./release-manifest.mjs";

const API_REPOSITORY = "ghcr.io/thevladbog/markiro-api";
const EDGE_REPOSITORY = "ghcr.io/thevladbog/markiro-platform-edge";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const IDENTITY_KEYS = [
  "sourceSha",
  "toolingSha",
  "workflowRunId",
  "workflowRunAttempt",
  "ciRunId",
  "ciRunAttempt",
];
const EVIDENCE_KEYS = [
  "version",
  "serverProfile",
  "uiProfile",
  ...IDENTITY_KEYS,
  "archiveSha256",
  "images",
];

function invalid() {
  throw new Error("invalid platform release evidence");
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function matchesPattern(value, pattern) {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}

function githubId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// The CI jobs a platform release requires, by the names GitHub reports. The
// post-migration forward rehearsal left production-bundle for its own jobs:
// both scenario runners and the job that accepts their evidence together. A
// main push that runs production-bundle always runs them (tools/ci/affected.mjs).
export const PLATFORM_CI_REQUIRED_JOBS = Object.freeze([
  "production-bundle",
  "platform-forward-recovery-scenario (healthy)",
  "platform-forward-recovery-scenario (replacement-failure)",
  "platform-forward-recovery",
  "ci-required",
]);

export function validatePlatformCiEvidence(run, jobsResponse, expected) {
  if (
    !exactKeys(expected, ["repository", "sourceSha", "runId"]) ||
    !matchesPattern(expected.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) ||
    !matchesPattern(expected.sourceSha, SHA) ||
    !matchesPattern(expected.runId, DECIMAL) ||
    !object(run) ||
    !githubId(run.id) ||
    !githubId(run.run_attempt) ||
    String(run.id) !== expected.runId ||
    run.name !== "CI" ||
    ![".github/workflows/ci.yml", ".github/workflows/ci.yml@refs/heads/main"].includes(run.path) ||
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.head_sha !== expected.sourceSha ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.repository?.full_name !== expected.repository ||
    run.head_repository?.full_name !== expected.repository ||
    !object(jobsResponse) ||
    !Array.isArray(jobsResponse.jobs) ||
    !githubId(jobsResponse.total_count) ||
    jobsResponse.total_count !== jobsResponse.jobs.length
  )
    invalid();

  const ids = new Set();
  const required = new Set(PLATFORM_CI_REQUIRED_JOBS);
  const found = new Set();
  for (const job of jobsResponse.jobs) {
    if (
      !object(job) ||
      !githubId(job.id) ||
      ids.has(job.id) ||
      !githubId(job.run_id) ||
      job.run_id !== run.id ||
      !githubId(job.run_attempt) ||
      job.run_attempt !== run.run_attempt ||
      job.head_sha !== expected.sourceSha
    )
      invalid();
    ids.add(job.id);
    if (!required.has(job.name)) continue;
    if (found.has(job.name) || job.status !== "completed" || job.conclusion !== "success")
      invalid();
    found.add(job.name);
  }
  if (found.size !== required.size) invalid();
  return { ciRunId: String(run.id), ciRunAttempt: String(run.run_attempt) };
}

function validIdentities(value) {
  return (
    IDENTITY_KEYS.every((key) => matchesPattern(value[key], key.endsWith("Sha") ? SHA : DECIMAL)) &&
    value.sourceSha === value.toolingSha
  );
}

function validateImagesEvidence(value) {
  if (
    !exactKeys(value, EVIDENCE_KEYS) ||
    value.version !== 1 ||
    value.serverProfile !== "platform-only" ||
    value.uiProfile !== "platform-only" ||
    !validIdentities(value) ||
    !matchesPattern(value.archiveSha256, HASH) ||
    !exactKeys(value.images, ["api", "edge"])
  )
    invalid();
  const tag = `platform-${value.sourceSha}-${value.workflowRunId}-${value.workflowRunAttempt}`;
  for (const [name, repository] of [
    ["api", API_REPOSITORY],
    ["edge", EDGE_REPOSITORY],
  ]) {
    const image = value.images[name];
    if (
      !exactKeys(image, ["tag", "id"]) ||
      image.tag !== `${repository}:${tag}` ||
      !matchesPattern(image.id, DIGEST)
    )
      invalid();
  }
  // Keep immutable SHA/image identity validation aligned with the existing
  // runtime manifest, whose version-1 schema remains unchanged.
  try {
    createPlatformManifest({
      sourceSha: value.sourceSha,
      toolingSha: value.toolingSha,
      workflowRunId: value.workflowRunId,
      apiDigest: value.images.api.id,
      edgeDigest: value.images.edge.id,
      createdAt: "1970-01-01T00:00:00.000Z",
    });
  } catch {
    invalid();
  }
  return value;
}

export function createVerifiedImagesEvidence(input) {
  return validateImagesEvidence(input);
}

export function parseVerifiedImagesEvidence(text, expected) {
  if (typeof text !== "string" || !exactKeys(expected, IDENTITY_KEYS) || !validIdentities(expected))
    invalid();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    invalid();
  }
  validateImagesEvidence(value);
  if (!IDENTITY_KEYS.every((key) => value[key] === expected[key])) invalid();
  return value;
}

export function resolvePublishedDigest(repositoryDigests, repository) {
  if (![API_REPOSITORY, EDGE_REPOSITORY].includes(repository) || !Array.isArray(repositoryDigests))
    invalid();
  const prefix = `${repository}@`;
  const matches = [];
  for (const reference of repositoryDigests) {
    if (typeof reference !== "string") invalid();
    if (!reference.startsWith(prefix)) continue;
    const digest = reference.slice(prefix.length);
    if (!matchesPattern(digest, DIGEST)) invalid();
    matches.push(digest);
  }
  if (matches.length !== 1) invalid();
  return matches[0];
}

function regularFile(stat) {
  return stat.isFile() && stat.nlink === 1n;
}

function sameFile(before, after) {
  return (
    regularFile(after) &&
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => before[key] === after[key])
  );
}

export async function sha256RegularFile(path) {
  let handle;
  try {
    const before = await fs.lstat(path, { bigint: true });
    if (!regularFile(before)) invalid();
    // NOFOLLOW prevents a link swap between lstat/open; NONBLOCK prevents a
    // substituted FIFO from blocking before descriptor validation.
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!sameFile(before, await handle.stat({ bigint: true }))) invalid();
    const hash = createHash("sha256");
    let size = 0n;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += BigInt(chunk.length);
    }
    if (
      size !== before.size ||
      !sameFile(before, await handle.stat({ bigint: true })) ||
      !sameFile(before, await fs.lstat(path, { bigint: true }))
    )
      invalid();
    return hash.digest("hex");
  } catch {
    invalid();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
