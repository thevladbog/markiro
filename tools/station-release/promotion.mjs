import { lstat, open, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { compareStationReleaseOrigins, validateStationReleaseDirectory } from "./artifacts.mjs";
import { parseStationBetaTag } from "./version.mjs";

const MAX_INPUT_BYTES = 256 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const ALLOWED_BETA_RELEASE_DIFF = [
  "apps/station/src-tauri/Cargo.toml",
  "apps/station/src-tauri/tauri.conf.json",
];

function invalid() {
  throw new Error("invalid accepted station beta");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

async function ensureDirectory(path) {
  if (typeof path !== "string" || path.length === 0) invalid();
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
  } catch (error) {
    if (error?.message === "invalid accepted station beta") throw error;
    invalid();
  }
}

export async function validateAcceptedBeta(input) {
  if (
    !hasExactKeys(input, [
      "sourceBetaTag",
      "release",
      "githubEvidence",
      "yandexEvidence",
      "githubTree",
      "yandexTree",
      "diffPaths",
    ])
  ) {
    invalid();
  }
  if (!hasExactKeys(input.release, ["tagName", "isDraft", "isPrerelease", "targetCommitish"])) {
    invalid();
  }

  const beta = parseStationBetaTag(input.sourceBetaTag);
  if (
    !beta ||
    input.release.tagName !== input.sourceBetaTag ||
    input.release.isDraft !== false ||
    input.release.isPrerelease !== true ||
    !SHA.test(input.release.targetCommitish) ||
    !Array.isArray(input.diffPaths) ||
    input.diffPaths.length !== ALLOWED_BETA_RELEASE_DIFF.length ||
    input.diffPaths.some((path, index) => path !== ALLOWED_BETA_RELEASE_DIFF[index])
  ) {
    invalid();
  }

  await Promise.all([ensureDirectory(input.githubTree), ensureDirectory(input.yandexTree)]);
  let github;
  let yandex;
  try {
    [github, yandex] = await Promise.all([
      validateStationReleaseDirectory(input.githubTree, {
        channel: "beta",
        origin: "github",
        version: beta.text,
      }),
      validateStationReleaseDirectory(input.yandexTree, {
        channel: "beta",
        origin: "yandex",
        version: beta.text,
      }),
    ]);
    await compareStationReleaseOrigins({
      githubDirectory: input.githubTree,
      yandexDirectory: input.yandexTree,
      channel: "beta",
      version: beta.text,
    });
  } catch {
    invalid();
  }
  if (
    !isDeepStrictEqual(input.githubEvidence, github.evidence) ||
    !isDeepStrictEqual(input.yandexEvidence, yandex.evidence) ||
    github.evidence.version !== beta.text ||
    yandex.evidence.version !== beta.text ||
    !SHA.test(github.evidence.baseSha) ||
    github.evidence.baseSha !== yandex.evidence.baseSha ||
    !SHA.test(github.evidence.releaseSha) ||
    github.evidence.releaseSha !== yandex.evidence.releaseSha
  ) {
    invalid();
  }

  return {
    sourceBetaTag: input.sourceBetaTag,
    betaVersion: beta.text,
    baseSha: github.evidence.baseSha,
    betaReleaseSha: github.evidence.releaseSha,
  };
}

async function readRegularText(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_INPUT_BYTES) invalid();
  return readFile(path, "utf8");
}

async function readJson(path) {
  try {
    return JSON.parse(await readRegularText(path));
  } catch (error) {
    if (error?.message === "invalid accepted station beta") throw error;
    invalid();
  }
}

async function writeOutput(path, promotion) {
  let handle;
  let created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(
      [
        `source_beta_tag=${promotion.sourceBetaTag}`,
        `beta_version=${promotion.betaVersion}`,
        `base_sha=${promotion.baseSha}`,
        `beta_release_sha=${promotion.betaReleaseSha}`,
        "",
      ].join("\n"),
      "utf8",
    );
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (created) await rm(path, { force: true });
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function main() {
  const [
    ,
    ,
    command,
    releasePath,
    githubEvidencePath,
    yandexEvidencePath,
    githubTree,
    yandexTree,
    diffPath,
    outputPath,
    ...extra
  ] = process.argv;
  if (
    command !== "validate-beta" ||
    !releasePath ||
    !githubEvidencePath ||
    !yandexEvidencePath ||
    !githubTree ||
    !yandexTree ||
    !diffPath ||
    !outputPath ||
    extra.length > 0
  ) {
    invalid();
  }
  const diffText = await readRegularText(diffPath);
  const release = await readJson(releasePath);
  const promotion = validateAcceptedBeta({
    sourceBetaTag: release.tagName,
    release,
    githubEvidence: await readJson(githubEvidencePath),
    yandexEvidence: await readJson(yandexEvidencePath),
    githubTree,
    yandexTree,
    diffPaths: diffText.split(/\r?\n/).filter(Boolean),
  });
  await writeOutput(outputPath, await promotion);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
