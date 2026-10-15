// The releases of «Markiro Автоном» that reached sites, and the window of
// compatibility during a rollout (plan ОБН-3, spec §10.11.6): one release
// back. Every release keeps its MIN_PROTOCOL_VERSION at or below the
// PROTOCOL_VERSION of the release before it, so a device of N−1 still works
// with a host of N, and only N−2 meets «Версии не совпадают». The owner adds
// a release's line in the commit that releases it.

import { readFile } from "node:fs/promises";

import { compareVersions } from "./sign-update.mjs";

export const RELEASES_FILE = "tools/standalone-release/releases.json";

const KEYS = "minProtocol,protocol,version";

/** The recorded releases, checked: exact keys, protocol ranges, strictly ascending versions. */
export async function readReleases(path = RELEASES_FILE) {
  const data = JSON.parse(await readFile(path, "utf8"));
  if (data?.schemaVersion !== 1 || !Array.isArray(data.releases)) {
    throw new Error(`${path} is not a list of releases`);
  }
  const releases = data.releases.map((entry) => {
    const keys = Object.keys(entry ?? {})
      .sort()
      .join(",");
    if (keys !== KEYS) throw new Error(`${path}: a release has the keys ${keys}, not ${KEYS}`);
    compareVersions(entry.version, entry.version);
    const { protocol, minProtocol } = entry;
    if (
      !Number.isInteger(protocol) ||
      !Number.isInteger(minProtocol) ||
      minProtocol < 1 ||
      minProtocol > protocol
    ) {
      throw new Error(`${path}: release ${entry.version} has no usable protocol range`);
    }
    return { version: entry.version, protocol, minProtocol };
  });
  for (let index = 1; index < releases.length; index += 1) {
    if (compareVersions(releases[index - 1].version, releases[index].version) >= 0) {
      throw new Error(`${path}: releases are not in order at ${releases[index].version}`);
    }
  }
  return releases;
}

/**
 * Throws unless `build` keeps the window of one release back against
 * `releases`; the release before it (or `null`) when it does.
 */
export function checkCompatibilityWindow(build, releases) {
  const same = releases.find((release) => compareVersions(release.version, build.version) === 0);
  if (
    same !== undefined &&
    (same.protocol !== build.protocol || same.minProtocol !== build.minProtocol)
  ) {
    throw new Error(
      `release ${build.version} is recorded with protocol ${same.minProtocol}..${same.protocol}, the build has ${build.minProtocol}..${build.protocol}`,
    );
  }
  const previous =
    releases.filter((release) => compareVersions(release.version, build.version) < 0).at(-1) ??
    null;
  if (previous !== null && build.protocol < previous.protocol) {
    throw new Error(
      `PROTOCOL_VERSION ${build.protocol} goes back from ${previous.protocol} of release ${previous.version}`,
    );
  }
  if (previous !== null && build.minProtocol > previous.protocol) {
    throw new Error(
      `MIN_PROTOCOL_VERSION ${build.minProtocol} is above PROTOCOL_VERSION ${previous.protocol} of release ${previous.version}: a device of the release before would not connect (window N−1, spec §10.11.6)`,
    );
  }
  return { previous };
}
