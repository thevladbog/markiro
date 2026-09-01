import { readFile } from "node:fs/promises";

export const SIGNER_TAURI_CONFIG = "apps/signer/src-tauri/tauri.conf.json";
export const SIGNER_DISTRIBUTION_BASELINE = "0.1.4";

const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function parseVersion(version) {
  const match = typeof version === "string" ? STABLE_VERSION.exec(version) : null;
  if (!match) {
    throw new Error(`${String(version)} is not a stable semantic version`);
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
  };
}

/** The single source of the release version; nothing else may name it. */
export async function readSignerVersion(configPath = SIGNER_TAURI_CONFIG) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const version = config?.version;
  if (typeof version !== "string" || !STABLE_VERSION.test(version)) {
    throw new Error(`${configPath} has no usable semantic version`);
  }
  return version;
}

export function parseSignerReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("signer-v")) return null;
  const version = tag.slice("signer-v".length);
  return STABLE_VERSION.test(version) ? version : null;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  return 0;
}

export function bumpSignerVersion(current, bump) {
  const version = parseVersion(current);
  if (bump === "patch") {
    return `${version.major}.${version.minor}.${version.patch + 1n}`;
  }
  if (bump === "minor") {
    return `${version.major}.${version.minor + 1n}.0`;
  }
  if (bump === "major") {
    return `${version.major + 1n}.0.0`;
  }
  throw new Error(`unsupported signer bump: ${String(bump)}`);
}

export function reconcileStableVersions({ githubVersion, yandexVersion }) {
  if (githubVersion !== null) parseVersion(githubVersion);
  if (yandexVersion !== null) parseVersion(yandexVersion);
  if (githubVersion === null && yandexVersion === null) return { kind: "empty" };
  if (githubVersion === null && yandexVersion === SIGNER_DISTRIBUTION_BASELINE) {
    return { kind: "aligned", version: yandexVersion };
  }
  if (githubVersion !== null && githubVersion === yandexVersion) {
    return { kind: "aligned", version: githubVersion };
  }
  throw new Error("signer stable channels disagree; run repair before publishing");
}

export function buildTauriVersionOverlay(version) {
  parseVersion(version);
  return { version };
}

function latestVersion(tags) {
  return (
    tags
      .map(parseSignerReleaseTag)
      .filter((version) => version !== null)
      .sort(compareVersions)
      .at(-1) ?? null
  );
}

export function resolveSignerReleaseAction({
  mode,
  bump,
  githubPublishedTags,
  githubDraftTags,
  yandexVersion,
}) {
  const githubVersion = latestVersion(githubPublishedTags);
  const drafts = githubDraftTags
    .map(parseSignerReleaseTag)
    .filter((version) => version !== null)
    .sort(compareVersions);

  if (mode === "publish") {
    if (drafts.length > 0) {
      throw new Error("a signer draft already exists; run repair before publishing");
    }
    const stable = reconcileStableVersions({ githubVersion, yandexVersion });
    if (stable.kind === "empty") {
      throw new Error("no signer stable baseline exists");
    }
    const version = bumpSignerVersion(stable.version, bump);
    return { mode, version, tag: signerReleaseTag(version) };
  }

  if (mode === "repair") {
    if (drafts.length !== 1) {
      throw new Error("repair requires exactly one signer draft");
    }
    const version = drafts[0];
    if (githubVersion !== null && compareVersions(version, githubVersion) <= 0) {
      throw new Error("signer repair draft is not newer than the published release");
    }
    const acceptedYandexVersions = new Set(
      [githubVersion, version, githubVersion === null ? SIGNER_DISTRIBUTION_BASELINE : null].filter(
        (value) => value !== null,
      ),
    );
    if (!acceptedYandexVersions.has(yandexVersion)) {
      throw new Error("signer repair state disagrees with the Yandex stable version");
    }
    return { mode, version, tag: signerReleaseTag(version) };
  }

  throw new Error(`unsupported signer release mode: ${String(mode)}`);
}

export function signerReleaseTag(version) {
  return `signer-v${version}`;
}

export function assertTagIsFree(tag, existingTags) {
  if (existingTags.includes(tag)) {
    throw new Error(
      `${tag} is already published; bump "version" in ${SIGNER_TAURI_CONFIG} rather than republishing`,
    );
  }
}

/**
 * `targets: ["nsis"]` with `createUpdaterArtifacts` yields the setup .exe and
 * a sibling .sig. The .exe is both the installer a human downloads and the
 * bundle the updater fetches, so there is exactly one artifact plus its
 * signature.
 */
export function signerArtifactNames(version) {
  const installer = `markiro-signer-${version}-windows-x86_64-setup.exe`;
  return { installer, signature: `${installer}.sig` };
}
