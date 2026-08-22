import { lstat, open, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

function validDate(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) && date.toISOString() === value && date.getTime() <= Date.now()
  );
}

export function validateAcceptedBeta(input) {
  if (!hasExactKeys(input, ["sourceBetaTag", "release", "evidence", "diffPaths"])) invalid();
  if (!hasExactKeys(input.release, ["tagName", "isDraft", "isPrerelease", "targetCommitish"])) {
    invalid();
  }
  if (
    !hasExactKeys(input.evidence, ["version", "baseSha", "releaseSha", "publishedAt", "assets"])
  ) {
    invalid();
  }

  const beta = parseStationBetaTag(input.sourceBetaTag);
  if (
    !beta ||
    input.release.tagName !== input.sourceBetaTag ||
    input.release.isDraft !== false ||
    input.release.isPrerelease !== true ||
    input.evidence.version !== beta.text ||
    !SHA.test(input.evidence.baseSha) ||
    !SHA.test(input.evidence.releaseSha) ||
    input.release.targetCommitish !== input.evidence.releaseSha ||
    !validDate(input.evidence.publishedAt) ||
    !isPlainObject(input.evidence.assets) ||
    !Array.isArray(input.diffPaths) ||
    input.diffPaths.length !== ALLOWED_BETA_RELEASE_DIFF.length ||
    input.diffPaths.some((path, index) => path !== ALLOWED_BETA_RELEASE_DIFF[index])
  ) {
    invalid();
  }

  return {
    sourceBetaTag: input.sourceBetaTag,
    betaVersion: beta.text,
    baseSha: input.evidence.baseSha,
    betaReleaseSha: input.evidence.releaseSha,
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
  const [, , command, releasePath, evidencePath, diffPath, outputPath, ...extra] = process.argv;
  if (
    command !== "validate-beta" ||
    !releasePath ||
    !evidencePath ||
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
    evidence: await readJson(evidencePath),
    diffPaths: diffText.split(/\r?\n/).filter(Boolean),
  });
  await writeOutput(outputPath, promotion);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
