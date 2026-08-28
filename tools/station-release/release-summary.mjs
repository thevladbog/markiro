import { appendFile, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { isCanonicalAbsolutePath } from "./canonical-path.mjs";
import { parseStationBetaTag, parseStationStableTag } from "./version.mjs";

const MODES = new Set(["publish", "promote-existing", "seed-baseline"]);
const IMMUTABLE_STATES = new Set([
  "not-started",
  "github-publication-attempted",
  "github-draft-created",
  "github-draft-assets-validated",
  "github-undraft-attempted",
  "github-public-validated",
  "yandex-publication-attempted",
  "both-origin-published",
  "existing-public-validation-started",
  "both-public-validated",
  "seed-publication-attempted",
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
const PROVENANCE_KEYS = [
  "sourceBetaTag",
  "baseSha",
  "releaseSha",
  "githubBetaEvidenceSha256",
  "yandexBetaEvidenceSha256",
];
const NORMAL_PROVENANCE_KEYS = ["version", ...PROVENANCE_KEYS];
const STABLE_DIGEST_KEYS = [
  "githubManifestSha256",
  "yandexManifestSha256",
  "githubEvidenceSha256",
  "yandexEvidenceSha256",
  "installerSha256",
  "bundleSha256",
  "signatureSha256",
];
const DIGEST_KEYS = ["githubBetaEvidenceSha256", "yandexBetaEvidenceSha256", ...STABLE_DIGEST_KEYS];
const DATA_KEYS = [...NORMAL_PROVENANCE_KEYS, ...STABLE_DIGEST_KEYS];
const STATE_KEYS = [
  "mode",
  "version",
  ...PROVENANCE_KEYS,
  ...STABLE_DIGEST_KEYS,
  "immutableState",
  "promotionState",
  "rollbackState",
  "outcome",
];
const SHA256 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_STATE_BYTES = 16 * 1024;

const BETA_IMMUTABLE_STATES = new Set([
  "not-started",
  "github-publication-attempted",
  "github-draft-created",
  "github-assets-uploaded",
  "github-draft-assets-validated",
  "github-undraft-attempted",
  "github-public-validated",
  "yandex-publication-attempted",
  "yandex-immutable-published",
  "existing-public-validation-started",
  "both-public-validated",
]);
const BETA_PROMOTION_STATES = new Set([
  "not-started",
  "mutable-backup-complete",
  "github-manifest-promoted",
  "yandex-manifest-promoted",
  "all-promoted",
]);
const BETA_DATA_KEYS = ["version", "sourceSha", "releaseSha", ...STABLE_DIGEST_KEYS];
const BETA_STATE_KEYS = [
  "mode",
  "version",
  "sourceSha",
  "releaseSha",
  ...STABLE_DIGEST_KEYS,
  "immutableState",
  "promotionState",
  "rollbackState",
  "outcome",
];

function invalid() {
  throw new Error("invalid station release summary");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

function validateProvenanceLifecycle(state, allowEmptyNormalProvenance) {
  if (state.mode === "seed-baseline") {
    if (
      state.sourceBetaTag !== null ||
      state.baseSha !== null ||
      state.githubBetaEvidenceSha256 !== null ||
      state.yandexBetaEvidenceSha256 !== null ||
      (state.version === null) !== (state.releaseSha === null)
    ) {
      invalid();
    }
    return;
  }
  const present = NORMAL_PROVENANCE_KEYS.filter((key) => state[key] !== null).length;
  if (present === NORMAL_PROVENANCE_KEYS.length) return;
  const pristine =
    present === 0 &&
    allowEmptyNormalProvenance &&
    STABLE_DIGEST_KEYS.every((key) => state[key] === null) &&
    state.immutableState === "not-started" &&
    state.promotionState === "not-started" &&
    state.rollbackState === "not-required" &&
    state.outcome === "pending";
  if (!pristine) invalid();
}

function validateState(state, { allowEmptyNormalProvenance = true } = {}) {
  const beta = state?.sourceBetaTag === null ? null : parseStationBetaTag(state?.sourceBetaTag);
  const stable =
    state?.version === null ? null : parseStationStableTag(`station-v${state?.version}`);
  if (
    !isPlainObject(state) ||
    Object.keys(state).sort().join(",") !== [...STATE_KEYS].sort().join(",") ||
    !MODES.has(state.mode) ||
    (state.version !== null && !stable) ||
    (state.sourceBetaTag !== null && !beta) ||
    (state.baseSha !== null && !SHA.test(state.baseSha)) ||
    (state.releaseSha !== null && !SHA.test(state.releaseSha)) ||
    DIGEST_KEYS.some((key) => state[key] !== null && !SHA256.test(state[key])) ||
    !IMMUTABLE_STATES.has(state.immutableState) ||
    !PROMOTION_STATES.has(state.promotionState) ||
    !ROLLBACK_STATES.has(state.rollbackState) ||
    !OUTCOMES.has(state.outcome)
  ) {
    invalid();
  }
  if (
    beta &&
    stable &&
    (beta.major !== stable.major || beta.minor !== stable.minor || beta.patch !== stable.patch)
  ) {
    invalid();
  }
  validateProvenanceLifecycle(state, allowEmptyNormalProvenance);
  return state;
}

export function createReleaseSummaryState(mode) {
  if (!MODES.has(mode)) invalid();
  return validateState({
    mode,
    version: null,
    sourceBetaTag: null,
    baseSha: null,
    releaseSha: null,
    ...Object.fromEntries(DIGEST_KEYS.map((key) => [key, null])),
    immutableState: "not-started",
    promotionState: "not-started",
    rollbackState: "not-required",
    outcome: "pending",
  });
}

export function updateReleaseSummary(state, patch) {
  validateState(state);
  if (!hasOnlyKeys(patch, DATA_KEYS) || Object.keys(patch).length === 0) {
    invalid();
  }
  return validateState(
    { ...state, ...patch },
    {
      allowEmptyNormalProvenance: !NORMAL_PROVENANCE_KEYS.some((key) => Object.hasOwn(patch, key)),
    },
  );
}

function immutableTransition(state, event, expectedState, nextState, mode = "publish") {
  if (
    state.mode !== mode ||
    state.immutableState !== expectedState ||
    state.promotionState !== "not-started" ||
    state.rollbackState !== "not-required" ||
    state.outcome !== "pending"
  ) {
    invalid();
  }
  return validateState({
    ...state,
    immutableState: nextState,
    ...(event === "seeded-and-provider-verified" ? { outcome: "seeded" } : {}),
  });
}

export function transitionReleaseSummary(state, event) {
  validateState(state);
  if (typeof event !== "string") invalid();
  const transitions = {
    "github-publication-attempted": ["not-started", "github-publication-attempted"],
    "github-draft-created": ["github-publication-attempted", "github-draft-created"],
    "github-draft-assets-validated": ["github-draft-created", "github-draft-assets-validated"],
    "github-undraft-attempted": ["github-draft-assets-validated", "github-undraft-attempted"],
    "github-public-validated": ["github-undraft-attempted", "github-public-validated"],
    "yandex-publication-attempted": ["github-public-validated", "yandex-publication-attempted"],
    "both-origin-published": ["yandex-publication-attempted", "both-origin-published"],
  };
  if (Object.hasOwn(transitions, event)) {
    const [expectedState, nextState] = transitions[event];
    return immutableTransition(state, event, expectedState, nextState);
  }
  if (event === "existing-public-validation-started") {
    return immutableTransition(
      state,
      event,
      "not-started",
      "existing-public-validation-started",
      "promote-existing",
    );
  }
  if (event === "both-public-validated" && state.mode === "promote-existing") {
    return immutableTransition(
      state,
      event,
      "existing-public-validation-started",
      "both-public-validated",
      "promote-existing",
    );
  }
  if (event === "both-public-validated") {
    return immutableTransition(state, event, "both-origin-published", "both-public-validated");
  }
  if (event === "seed-publication-attempted") {
    return immutableTransition(
      state,
      event,
      "not-started",
      "seed-publication-attempted",
      "seed-baseline",
    );
  }
  if (event === "seeded-and-provider-verified") {
    return immutableTransition(
      state,
      event,
      "seed-publication-attempted",
      "seeded-and-provider-verified",
      "seed-baseline",
    );
  }
  if (event === "github-promoted") {
    if (
      state.mode === "seed-baseline" ||
      state.immutableState !== "both-public-validated" ||
      state.promotionState !== "not-started" ||
      state.rollbackState !== "not-required" ||
      state.outcome !== "pending"
    ) {
      invalid();
    }
    return validateState({ ...state, promotionState: "github-promoted" });
  }
  if (event === "all-promoted") {
    if (
      state.promotionState !== "github-promoted" ||
      state.rollbackState !== "not-required" ||
      state.outcome !== "pending"
    ) {
      invalid();
    }
    return validateState({ ...state, promotionState: "all-promoted", outcome: "promoted" });
  }
  if (event === "restored" || event === "restoration-failed") {
    if (
      state.mode === "seed-baseline" ||
      state.immutableState !== "both-public-validated" ||
      state.promotionState === "all-promoted" ||
      state.rollbackState !== "not-required" ||
      state.outcome !== "pending"
    ) {
      invalid();
    }
    return validateState({
      ...state,
      rollbackState: event,
      outcome: event === "restored" ? "restored-after-failure" : "restoration-failed",
    });
  }
  invalid();
}

function display(value) {
  return value === null ? "not-recorded" : value;
}

function renderedOutcome(state) {
  if (state.outcome !== "pending") return state.outcome;
  if (state.rollbackState === "restored") return "restored-after-failure";
  if (state.rollbackState === "restoration-failed") return "restoration-failed";
  if (state.immutableState === "existing-public-validation-started") {
    return "existing-immutables-not-validated";
  }
  if (state.immutableState === "both-public-validated") {
    return "immutable-but-not-promoted";
  }
  if (state.immutableState !== "not-started") return "partial-immutables";
  return "not-completed";
}

export function renderReleaseSummary(state) {
  validateState(state);
  const output = `${[
    "## Markiro Station stable publication",
    `- Mode: \`${state.mode}\``,
    `- Version: \`${display(state.version)}\``,
    `- Source beta: \`${display(state.sourceBetaTag)}\``,
    `- Base commit: \`${display(state.baseSha)}\``,
    `- Release commit: \`${display(state.releaseSha)}\``,
    `- GitHub accepted-beta evidence SHA-256: \`${display(state.githubBetaEvidenceSha256)}\``,
    `- Yandex accepted-beta evidence SHA-256: \`${display(state.yandexBetaEvidenceSha256)}\``,
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

function validateBetaState(state, { allowEmptyProvenance = true } = {}) {
  const beta = state?.version === null ? null : parseStationBetaTag(`station-v${state?.version}`);
  if (
    !isPlainObject(state) ||
    Object.keys(state).sort().join(",") !== [...BETA_STATE_KEYS].sort().join(",") ||
    !MODES.has(state.mode) ||
    (state.version !== null && !beta) ||
    (state.sourceSha !== null && !SHA.test(state.sourceSha)) ||
    (state.releaseSha !== null && !SHA.test(state.releaseSha)) ||
    STABLE_DIGEST_KEYS.some((key) => state[key] !== null && !SHA256.test(state[key])) ||
    !BETA_IMMUTABLE_STATES.has(state.immutableState) ||
    !BETA_PROMOTION_STATES.has(state.promotionState) ||
    !ROLLBACK_STATES.has(state.rollbackState) ||
    !OUTCOMES.has(state.outcome)
  ) {
    invalid();
  }
  const provenance = [state.version, state.sourceSha, state.releaseSha];
  const present = provenance.filter((value) => value !== null).length;
  const pristine =
    present === 0 &&
    allowEmptyProvenance &&
    STABLE_DIGEST_KEYS.every((key) => state[key] === null) &&
    state.immutableState === "not-started" &&
    state.promotionState === "not-started" &&
    state.rollbackState === "not-required" &&
    state.outcome === "pending";
  if (present !== provenance.length && !pristine) invalid();
  return state;
}

export function createBetaReleaseSummaryState(mode) {
  if (!MODES.has(mode)) invalid();
  return validateBetaState({
    mode,
    version: null,
    sourceSha: null,
    releaseSha: null,
    ...Object.fromEntries(STABLE_DIGEST_KEYS.map((key) => [key, null])),
    immutableState: "not-started",
    promotionState: "not-started",
    rollbackState: "not-required",
    outcome: "pending",
  });
}

export function updateBetaReleaseSummary(state, patch) {
  validateBetaState(state);
  if (!hasOnlyKeys(patch, BETA_DATA_KEYS) || Object.keys(patch).length === 0) invalid();
  return validateBetaState(
    { ...state, ...patch },
    {
      allowEmptyProvenance: !["version", "sourceSha", "releaseSha"].some((key) =>
        Object.hasOwn(patch, key),
      ),
    },
  );
}

function transitionBetaImmutable(state, expected, next, mode = state.mode) {
  if (
    state.mode !== mode ||
    state.immutableState !== expected ||
    state.promotionState !== "not-started" ||
    state.rollbackState !== "not-required" ||
    state.outcome !== "pending"
  ) {
    invalid();
  }
  return validateBetaState({ ...state, immutableState: next });
}

export function transitionBetaReleaseSummary(state, event) {
  validateBetaState(state, { allowEmptyProvenance: false });
  const publishTransitions = {
    "github-publication-attempted": ["not-started", "github-publication-attempted"],
    "github-draft-created": ["github-publication-attempted", "github-draft-created"],
    "github-assets-uploaded": ["github-draft-created", "github-assets-uploaded"],
    "github-draft-assets-validated": ["github-assets-uploaded", "github-draft-assets-validated"],
    "github-undraft-attempted": ["github-draft-assets-validated", "github-undraft-attempted"],
    "github-public-validated": ["github-undraft-attempted", "github-public-validated"],
    "yandex-publication-attempted": ["github-public-validated", "yandex-publication-attempted"],
    "yandex-immutable-published": ["yandex-publication-attempted", "yandex-immutable-published"],
  };
  if (Object.hasOwn(publishTransitions, event)) {
    if (state.mode !== "publish" && state.mode !== "seed-baseline") invalid();
    const [expected, next] = publishTransitions[event];
    return transitionBetaImmutable(state, expected, next);
  }
  if (event === "existing-public-validation-started") {
    return transitionBetaImmutable(
      state,
      "not-started",
      "existing-public-validation-started",
      "promote-existing",
    );
  }
  if (event === "both-public-validated") {
    const expected =
      state.mode === "promote-existing"
        ? "existing-public-validation-started"
        : "yandex-immutable-published";
    return transitionBetaImmutable(state, expected, "both-public-validated");
  }
  const promotionTransitions = {
    "mutable-backup-complete": ["not-started", "mutable-backup-complete"],
    "github-manifest-promoted": ["mutable-backup-complete", "github-manifest-promoted"],
    "yandex-manifest-promoted": ["github-manifest-promoted", "yandex-manifest-promoted"],
    "all-promoted": ["yandex-manifest-promoted", "all-promoted"],
  };
  if (Object.hasOwn(promotionTransitions, event)) {
    const [expected, next] = promotionTransitions[event];
    if (
      state.immutableState !== "both-public-validated" ||
      state.promotionState !== expected ||
      state.rollbackState !== "not-required" ||
      state.outcome !== "pending"
    ) {
      invalid();
    }
    return validateBetaState({
      ...state,
      promotionState: next,
      ...(event === "all-promoted"
        ? { outcome: state.mode === "seed-baseline" ? "seeded" : "promoted" }
        : {}),
    });
  }
  if (event === "restored" || event === "restoration-failed") {
    if (
      state.immutableState !== "both-public-validated" ||
      state.promotionState === "not-started" ||
      state.promotionState === "all-promoted" ||
      state.rollbackState !== "not-required" ||
      state.outcome !== "pending"
    ) {
      invalid();
    }
    return validateBetaState({
      ...state,
      rollbackState: event,
      outcome: event === "restored" ? "restored-after-failure" : "restoration-failed",
    });
  }
  invalid();
}

function renderedBetaOutcome(state) {
  if (state.outcome !== "pending") return state.outcome;
  if (state.immutableState === "existing-public-validation-started") {
    return "existing-immutables-not-validated";
  }
  if (state.immutableState === "both-public-validated") return "immutable-but-not-promoted";
  if (state.immutableState !== "not-started") return "partial-immutables";
  return "not-completed";
}

export function renderBetaReleaseSummary(state) {
  validateBetaState(state);
  const output = `${[
    "## Markiro Station beta publication",
    `- Mode: \`${state.mode}\``,
    `- Version: \`${display(state.version)}\``,
    `- Source commit: \`${display(state.sourceSha)}\``,
    `- Release commit: \`${display(state.releaseSha)}\``,
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
    `- Outcome: \`${renderedBetaOutcome(state)}\``,
    "- External acceptance: `NOT_RUN` (Authenticode, Windows, updater, and hardware).",
  ].join("\n")}\n`;
  if (Buffer.byteLength(output) > 8192) invalid();
  return output;
}

function ensureAbsolutePath(path) {
  if (!isCanonicalAbsolutePath(path)) invalid();
}

async function readState(path, validator = validateState) {
  ensureAbsolutePath(path);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_STATE_BYTES) {
      invalid();
    }
    return validator(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.message === "invalid station release summary") throw error;
    invalid();
  }
}

async function writeExclusive(path, state, validator = validateState) {
  ensureAbsolutePath(path);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(validator(state))}\n`);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function replaceState(path, state, validator = validateState) {
  const temporary = `${path}.station-summary-${process.pid}.tmp`;
  await writeExclusive(temporary, state, validator);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const [, , command, ...args] = process.argv;
  const betaCommand = command.startsWith("beta-");
  const operation = betaCommand ? command.slice("beta-".length) : command;
  const create = betaCommand ? createBetaReleaseSummaryState : createReleaseSummaryState;
  const update = betaCommand ? updateBetaReleaseSummary : updateReleaseSummary;
  const transition = betaCommand ? transitionBetaReleaseSummary : transitionReleaseSummary;
  const render = betaCommand ? renderBetaReleaseSummary : renderReleaseSummary;
  const validator = betaCommand ? validateBetaState : validateState;
  if (operation === "init") {
    const [mode, path, ...extra] = args;
    if (!mode || !path || extra.length > 0) invalid();
    await writeExclusive(path, create(mode), validator);
    return;
  }
  if (operation === "update") {
    const [path, ...pairs] = args;
    if (!path || pairs.length === 0 || pairs.length % 2 !== 0) invalid();
    const patch = {};
    for (let index = 0; index < pairs.length; index += 2) {
      const key = pairs[index];
      const value = pairs[index + 1];
      if (!key || value === undefined || Object.hasOwn(patch, key)) invalid();
      patch[key] = value === "null" ? null : value;
    }
    await replaceState(path, update(await readState(path, validator), patch), validator);
    return;
  }
  if (operation === "transition") {
    const [path, event, ...extra] = args;
    if (!path || !event || extra.length > 0) invalid();
    await replaceState(path, transition(await readState(path, validator), event), validator);
    return;
  }
  if (operation === "render") {
    const [path, outputPath, ...extra] = args;
    if (!path || !outputPath || extra.length > 0) invalid();
    ensureAbsolutePath(outputPath);
    const parent = await lstat(dirname(outputPath));
    if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
    await appendFile(outputPath, render(await readState(path, validator)), { mode: 0o600 });
    return;
  }
  invalid();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
