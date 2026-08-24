import { appendFile, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseStationStableTag } from "./version.mjs";

const MODES = new Set(["publish", "promote-existing", "seed-baseline"]);
const IMMUTABLE_STATES = new Set([
  "not-started",
  "github-published",
  "yandex-publication-attempted",
  "both-published",
  "both-public-validated",
  "seeded-and-provider-verified",
]);
const PROMOTION_STATES = new Set(["not-started", "github-promoted", "all-promoted"]);
const ROLLBACK_STATES = new Set(["not-required", "restored", "restoration-failed"]);
const OUTCOMES = new Set([
  "pending",
  "promoted",
  "seeded",
  "restored-after-failure",
  "restoration-failed",
]);
const DIGEST_KEYS = [
  "githubManifestSha256",
  "yandexManifestSha256",
  "githubEvidenceSha256",
  "yandexEvidenceSha256",
  "installerSha256",
  "bundleSha256",
  "signatureSha256",
];
const STATE_KEYS = [
  "mode",
  "version",
  ...DIGEST_KEYS,
  "immutableState",
  "promotionState",
  "rollbackState",
  "outcome",
];
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_STATE_BYTES = 16 * 1024;

function invalid() {
  throw new Error("invalid station release summary");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

function validateState(state) {
  if (
    !isPlainObject(state) ||
    Object.keys(state).sort().join(",") !== [...STATE_KEYS].sort().join(",") ||
    !MODES.has(state.mode) ||
    (state.version !== null && !parseStationStableTag(`station-v${state.version}`)) ||
    DIGEST_KEYS.some((key) => state[key] !== null && !SHA256.test(state[key])) ||
    !IMMUTABLE_STATES.has(state.immutableState) ||
    !PROMOTION_STATES.has(state.promotionState) ||
    !ROLLBACK_STATES.has(state.rollbackState) ||
    !OUTCOMES.has(state.outcome)
  ) {
    invalid();
  }
  return state;
}

export function createReleaseSummaryState(mode) {
  if (!MODES.has(mode)) invalid();
  return validateState({
    mode,
    version: null,
    ...Object.fromEntries(DIGEST_KEYS.map((key) => [key, null])),
    immutableState: "not-started",
    promotionState: "not-started",
    rollbackState: "not-required",
    outcome: "pending",
  });
}

export function updateReleaseSummary(state, patch) {
  validateState(state);
  if (!hasOnlyKeys(patch, STATE_KEYS) || Object.keys(patch).length === 0 || "mode" in patch) {
    invalid();
  }
  return validateState({ ...state, ...patch });
}

function display(value) {
  return value === null ? "not-recorded" : value;
}

function renderedOutcome(state) {
  if (state.outcome !== "pending") return state.outcome;
  if (state.rollbackState === "restored") return "restored-after-failure";
  if (state.rollbackState === "restoration-failed") return "restoration-failed";
  if (state.immutableState !== "not-started" && state.promotionState !== "all-promoted") {
    return "immutable-but-not-promoted";
  }
  return "not-completed";
}

export function renderReleaseSummary(state) {
  validateState(state);
  const output = `${[
    "## Markiro Station stable publication",
    `- Mode: \`${state.mode}\``,
    `- Version: \`${display(state.version)}\``,
    `- GitHub manifest SHA-256: \`${display(state.githubManifestSha256)}\``,
    `- Yandex manifest SHA-256: \`${display(state.yandexManifestSha256)}\``,
    `- GitHub evidence SHA-256: \`${display(state.githubEvidenceSha256)}\``,
    `- Yandex evidence SHA-256: \`${display(state.yandexEvidenceSha256)}\``,
    `- Installer SHA-256: \`${display(state.installerSha256)}\``,
    `- Updater bundle SHA-256: \`${display(state.bundleSha256)}\``,
    `- Detached signature SHA-256: \`${display(state.signatureSha256)}\``,
    `- Immutable publication: \`${state.immutableState}\``,
    `- Promotion: \`${state.promotionState}\``,
    `- Rollback/restoration: \`${state.rollbackState}\``,
    `- Outcome: \`${renderedOutcome(state)}\``,
    "- Authenticode and physical Windows acceptance remain external.",
  ].join("\n")}\n`;
  if (Buffer.byteLength(output) > 8192) invalid();
  return output;
}

function ensureAbsolutePath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) invalid();
}

async function readState(path) {
  ensureAbsolutePath(path);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_STATE_BYTES) {
      invalid();
    }
    return validateState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.message === "invalid station release summary") throw error;
    invalid();
  }
}

async function writeExclusive(path, state) {
  ensureAbsolutePath(path);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(validateState(state))}\n`);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function replaceState(path, state) {
  const temporary = `${path}.station-summary-${process.pid}.tmp`;
  await writeExclusive(temporary, state);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (command === "init") {
    const [mode, path, ...extra] = args;
    if (!mode || !path || extra.length > 0) invalid();
    await writeExclusive(path, createReleaseSummaryState(mode));
    return;
  }
  if (command === "update") {
    const [path, ...pairs] = args;
    if (!path || pairs.length === 0 || pairs.length % 2 !== 0) invalid();
    const patch = {};
    for (let index = 0; index < pairs.length; index += 2) {
      const key = pairs[index];
      const value = pairs[index + 1];
      if (!key || value === undefined || Object.hasOwn(patch, key)) invalid();
      patch[key] = value === "null" ? null : value;
    }
    await replaceState(path, updateReleaseSummary(await readState(path), patch));
    return;
  }
  if (command === "render") {
    const [path, outputPath, ...extra] = args;
    if (!path || !outputPath || extra.length > 0) invalid();
    ensureAbsolutePath(outputPath);
    const parent = await lstat(dirname(outputPath));
    if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
    await appendFile(outputPath, renderReleaseSummary(await readState(path)), { mode: 0o600 });
    return;
  }
  invalid();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
