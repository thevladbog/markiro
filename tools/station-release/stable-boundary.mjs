import { execFile as execFileCallback } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  validateLegacyGithubStationReleaseDirectory,
  validateStationReleaseDirectory,
} from "./artifacts.mjs";
import { parseStationBetaTag, parseStationStableTag } from "./version.mjs";

const execFile = promisify(execFileCallback);
const MODES = new Set(["publish", "promote-existing"]);
const SHA = /^[0-9a-f]{40}$/;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RELEASES = 10_000;
const OVERLAY_PATHS = "apps/station/src-tauri/Cargo.toml\napps/station/src-tauri/tauri.conf.json";

function invalid() {
  throw new Error("invalid station stable boundary");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function compareStable(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] - right[field];
  }
  return 0;
}

function listedReleaseRecord(value) {
  if (
    !hasExactKeys(value, ["tagName", "isDraft", "isPrerelease", "publishedAt"]) ||
    typeof value.tagName !== "string" ||
    typeof value.isDraft !== "boolean" ||
    typeof value.isPrerelease !== "boolean" ||
    (value.publishedAt !== null &&
      (typeof value.publishedAt !== "string" ||
        Buffer.byteLength(value.publishedAt) > 64 ||
        !value.publishedAt.endsWith("Z") ||
        !Number.isFinite(Date.parse(value.publishedAt)))) ||
    value.isDraft !== (value.publishedAt === null)
  ) {
    invalid();
  }
  return {
    ...value,
    beta: parseStationBetaTag(value.tagName),
    stable: parseStationStableTag(value.tagName),
  };
}

function releaseMetadataRecord(value) {
  if (
    !hasExactKeys(value, ["tagName", "isDraft", "isPrerelease", "targetCommitish"]) ||
    typeof value.tagName !== "string" ||
    typeof value.isDraft !== "boolean" ||
    typeof value.isPrerelease !== "boolean" ||
    typeof value.targetCommitish !== "string"
  ) {
    invalid();
  }
  const beta = parseStationBetaTag(value.tagName);
  const stable = parseStationStableTag(value.tagName);
  if ((beta || stable) && !SHA.test(value.targetCommitish)) invalid();
  return { ...value, beta, stable };
}

export function resolveStableReleaseState({ mode, sourceBetaTag, releases, repositoryTags } = {}) {
  if (
    !MODES.has(mode) ||
    !Array.isArray(releases) ||
    releases.length > MAX_RELEASES ||
    !Array.isArray(repositoryTags) ||
    repositoryTags.length > MAX_RELEASES
  ) {
    invalid();
  }
  const sourceBeta = parseStationBetaTag(sourceBetaTag);
  if (!sourceBeta) invalid();
  const records = releases.map(listedReleaseRecord);
  const sourceRelease = records.find((record) => record.tagName === sourceBetaTag);
  if (!sourceRelease || sourceRelease.isDraft || !sourceRelease.isPrerelease) invalid();

  for (const tag of repositoryTags) {
    if (
      typeof tag !== "string" ||
      Buffer.byteLength(tag) > 256 ||
      (tag.startsWith("station-v") && !parseStationBetaTag(tag) && !parseStationStableTag(tag))
    ) {
      invalid();
    }
  }

  const target = {
    major: sourceBeta.major,
    minor: sourceBeta.minor,
    patch: sourceBeta.patch,
  };
  const version = `${target.major}.${target.minor}.${target.patch}`;
  const tag = `station-v${version}`;
  const stableReleases = records
    .filter((record) => record.stable && !record.isDraft && !record.isPrerelease)
    .sort((left, right) => compareStable(left.stable, right.stable));
  const latestStable = stableReleases.at(-1) ?? null;

  if (mode === "publish") {
    if (
      repositoryTags.includes(tag) ||
      stableReleases.some((record) => record.tagName === tag) ||
      (latestStable && compareStable(target, latestStable.stable) <= 0)
    ) {
      invalid();
    }
  } else if (!latestStable || latestStable.tagName !== tag) {
    invalid();
  }

  const firstBeta = records
    .filter(
      (record) =>
        record.beta &&
        !record.isDraft &&
        record.isPrerelease &&
        record.beta.major === target.major &&
        record.beta.minor === target.minor &&
        record.beta.patch === target.patch &&
        record.beta.beta <= sourceBeta.beta,
    )
    .sort((left, right) => left.beta.beta - right.beta.beta)
    .at(0);
  if (!firstBeta) invalid();

  return {
    version,
    tag,
    previousStableTag:
      mode === "publish"
        ? (latestStable?.tagName ?? null)
        : (stableReleases.at(-2)?.tagName ?? null),
    firstBetaTag: firstBeta.tagName,
  };
}

async function ensureRepository(repository) {
  if (
    typeof repository !== "string" ||
    !isAbsolute(repository) ||
    resolve(repository) !== repository
  ) {
    invalid();
  }
  try {
    const info = await lstat(repository);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
  } catch (error) {
    if (error?.message === "invalid station stable boundary") throw error;
    invalid();
  }
}

async function git(repository, args, { allowFailure = false } = {}) {
  try {
    return (
      await execFile("git", args, {
        cwd: repository,
        encoding: "utf8",
        maxBuffer: MAX_INPUT_BYTES,
      })
    ).stdout.trim();
  } catch {
    if (allowFailure) return null;
    invalid();
  }
}

function validatePublishedMetadata(metadata, expectedChannel) {
  const record = releaseMetadataRecord(metadata);
  const parsed =
    expectedChannel === "stable"
      ? parseStationStableTag(record.tagName)
      : parseStationBetaTag(record.tagName);
  if (
    !parsed ||
    record.isDraft ||
    record.isPrerelease !== (expectedChannel === "beta") ||
    !SHA.test(record.targetCommitish)
  ) {
    invalid();
  }
  return { record, parsed };
}

async function validateTreeBoundary({
  repository,
  metadata,
  tree,
  channel,
  currentBaseSha,
  allowLegacy,
}) {
  const { record, parsed } = validatePublishedMetadata(metadata, channel);
  let validated;
  try {
    validated = await validateStationReleaseDirectory(tree, {
      channel,
      origin: "github",
      version: parsed.text,
    });
  } catch {
    if (channel !== "stable" || allowLegacy !== true) invalid();
    try {
      validated = await validateLegacyGithubStationReleaseDirectory(tree, {
        channel,
        version: parsed.text,
      });
    } catch {
      invalid();
    }
  }
  const { evidence } = validated;
  if (
    evidence.releaseSha !== record.targetCommitish ||
    !SHA.test(evidence.baseSha) ||
    !SHA.test(evidence.releaseSha)
  ) {
    invalid();
  }
  await git(repository, ["cat-file", "-e", `${evidence.baseSha}^{commit}`]);
  await git(repository, ["cat-file", "-e", `${evidence.releaseSha}^{commit}`]);
  if ((await git(repository, ["rev-parse", `${evidence.releaseSha}^`])) !== evidence.baseSha) {
    invalid();
  }
  if (
    (await git(repository, ["diff", "--name-only", evidence.baseSha, evidence.releaseSha])) !==
    OVERLAY_PATHS
  ) {
    invalid();
  }
  const ancestor = await git(
    repository,
    ["merge-base", "--is-ancestor", evidence.baseSha, currentBaseSha],
    { allowFailure: true },
  );
  if (ancestor === null) invalid();
  return { parsed, evidence };
}

export async function resolveStableChangelogBoundary({
  repository,
  currentBaseSha,
  sourceBetaTag,
  previous,
  firstBeta,
} = {}) {
  await ensureRepository(repository);
  const sourceBeta = parseStationBetaTag(sourceBetaTag);
  if (!sourceBeta || !SHA.test(currentBaseSha) || (previous === null) === (firstBeta === null)) {
    invalid();
  }
  await git(repository, ["cat-file", "-e", `${currentBaseSha}^{commit}`]);

  if (previous !== null) {
    if (
      !hasExactKeys(previous, ["metadata", "tree", "allowLegacy"]) ||
      typeof previous.allowLegacy !== "boolean"
    ) {
      invalid();
    }
    const boundary = await validateTreeBoundary({
      repository,
      metadata: previous.metadata,
      tree: previous.tree,
      channel: "stable",
      currentBaseSha,
      allowLegacy: previous.allowLegacy,
    });
    if (compareStable(boundary.parsed, sourceBeta) >= 0) invalid();
    return {
      fromSha: boundary.evidence.baseSha,
      previousStableBaseSha: boundary.evidence.baseSha,
    };
  }

  if (!hasExactKeys(firstBeta, ["metadata", "tree"])) invalid();
  const boundary = await validateTreeBoundary({
    repository,
    metadata: firstBeta.metadata,
    tree: firstBeta.tree,
    channel: "beta",
    currentBaseSha,
    allowLegacy: false,
  });
  if (
    boundary.parsed.major !== sourceBeta.major ||
    boundary.parsed.minor !== sourceBeta.minor ||
    boundary.parsed.patch !== sourceBeta.patch ||
    boundary.parsed.beta > sourceBeta.beta
  ) {
    invalid();
  }
  const parent = await git(repository, ["rev-parse", `${boundary.evidence.baseSha}^`], {
    allowFailure: true,
  });
  return { fromSha: parent ?? boundary.evidence.baseSha, previousStableBaseSha: null };
}

async function readBounded(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) invalid();
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_INPUT_BYTES) {
      invalid();
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.message === "invalid station stable boundary") throw error;
    invalid();
  }
}

async function writeExclusive(path, content) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) invalid();
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function parseJson(path) {
  try {
    return JSON.parse(await readBounded(path));
  } catch (error) {
    if (error?.message === "invalid station stable boundary") throw error;
    invalid();
  }
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (command === "resolve-state") {
    const [mode, sourceBetaTag, releasesPath, tagsPath, outputPath, ...extra] = args;
    if (!mode || !sourceBetaTag || !releasesPath || !tagsPath || !outputPath || extra.length > 0) {
      invalid();
    }
    const releases = await parseJson(releasesPath);
    const repositoryTags = (await readBounded(tagsPath)).split(/\r?\n/).filter(Boolean);
    const state = resolveStableReleaseState({ mode, sourceBetaTag, releases, repositoryTags });
    await writeExclusive(
      outputPath,
      `version=${state.version}\ntag=${state.tag}\nprevious_stable_tag=${state.previousStableTag ?? ""}\nfirst_beta_tag=${state.firstBetaTag}\n`,
    );
    return;
  }
  if (command === "resolve-changelog") {
    const [
      currentBaseSha,
      sourceBetaTag,
      previousMetadataPath,
      previousTree,
      firstBetaMetadataPath,
      firstBetaTree,
      outputPath,
      ...flags
    ] = args;
    if (
      !currentBaseSha ||
      !sourceBetaTag ||
      !previousMetadataPath ||
      !previousTree ||
      !firstBetaMetadataPath ||
      !firstBetaTree ||
      !outputPath ||
      flags.some((flag) => flag !== "--allow-legacy-previous") ||
      new Set(flags).size !== flags.length
    ) {
      invalid();
    }
    const hasPrevious = previousMetadataPath !== "-" || previousTree !== "-";
    const hasFirstBeta = firstBetaMetadataPath !== "-" || firstBetaTree !== "-";
    if (hasPrevious === hasFirstBeta || (previousMetadataPath === "-") !== (previousTree === "-")) {
      invalid();
    }
    if ((firstBetaMetadataPath === "-") !== (firstBetaTree === "-")) invalid();
    const boundary = await resolveStableChangelogBoundary({
      repository: process.cwd(),
      currentBaseSha,
      sourceBetaTag,
      previous: hasPrevious
        ? {
            metadata: await parseJson(previousMetadataPath),
            tree: previousTree,
            allowLegacy: flags.includes("--allow-legacy-previous"),
          }
        : null,
      firstBeta: hasFirstBeta
        ? { metadata: await parseJson(firstBetaMetadataPath), tree: firstBetaTree }
        : null,
    });
    await writeExclusive(
      outputPath,
      `from_sha=${boundary.fromSha}\nprevious_stable_base_sha=${boundary.previousStableBaseSha ?? ""}\n`,
    );
    return;
  }
  invalid();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
