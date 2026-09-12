import { parseHandheldManifest } from "./manifest.mjs";

/** What the first release of an empty channel publishes; `bump` has nothing to apply to. */
export const HANDHELD_DISTRIBUTION_BASELINE = "0.1.0";

const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MAX_VERSION_CODE = 2 ** 31 - 1;

function parseVersion(version) {
  const match = typeof version === "string" ? STABLE_VERSION.exec(version) : null;
  if (!match) throw new Error(`${String(version)} is not a stable semantic version`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function bumpHandheldVersion(current, bump) {
  const version = parseVersion(current);
  if (bump === "patch") return `${version.major}.${version.minor}.${version.patch + 1}`;
  if (bump === "minor") return `${version.major}.${version.minor + 1}.0`;
  if (bump === "major") return `${version.major + 1}.0.0`;
  throw new Error(`unsupported handheld bump: ${String(bump)}`);
}

/**
 * The next release, computed from what the channel actually serves.
 *
 * Neither number is typed by a person. `versionCode` in particular is the one
 * an operator never sees and a terminal compares on: typed by hand it is a
 * repeat waiting to happen, and a repeat is an update every installed terminal
 * silently refuses.
 */
export function nextHandheldRelease({ publishedText, bump, channel = "stable" }) {
  if (publishedText === null || publishedText === undefined) {
    return { versionName: HANDHELD_DISTRIBUTION_BASELINE, versionCode: 1, first: true };
  }
  const published = parseHandheldManifest(publishedText, { channel });
  const versionCode = published.versionCode + 1;
  if (versionCode > MAX_VERSION_CODE) throw new Error("versionCode has run out of Android int");
  return {
    versionName: bumpHandheldVersion(published.versionName, bump),
    versionCode,
    first: false,
  };
}
