import { parseHandheldManifest } from "./manifest.mjs";

/**
 * The newest build a terminal may already run, with where it came from. A
 * release must carry a larger `versionCode`, or every terminal running this
 * build refuses it.
 *
 * Recorded from the release workflow history on 2026-10-22, when the channels
 * moved to an empty Timeweb bucket: stable 1.6.0 (14) is the last published
 * build (run 38116056639, 2026-10-11), and 1.6.1 (15) is the newer pilot
 * artifact built from `standalone/pilot-mvp` (run 39088123680, 2026-10-18).
 * The pilot build was never published, but it may have been installed by
 * hand. The beta channel was never published. Raise this, in a reviewed
 * commit, only from the same kind of evidence.
 */
export const HANDHELD_LAST_DISTRIBUTED = Object.freeze({ versionName: "1.6.1", versionCode: 15 });

/** What a dispatch types to continue an empty channel after the recorded build. */
export const HANDHELD_EMPTY_CHANNEL_CONFIRMATION = `${HANDHELD_LAST_DISTRIBUTED.versionName} (${HANDHELD_LAST_DISTRIBUTED.versionCode})`;

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
 *
 * An empty channel is not a fresh start: terminals in the field already run
 * `HANDHELD_LAST_DISTRIBUTED`. It continues from that reviewed record, and only
 * when the dispatch confirms it by typing `HANDHELD_EMPTY_CHANNEL_CONFIRMATION`;
 * a channel that serves a pointer refuses the confirmation, so it cannot be
 * used to step over what is published.
 */
export function nextHandheldRelease({
  publishedText,
  bump,
  channel = "stable",
  emptyChannelConfirmation = "",
}) {
  const empty = publishedText === null || publishedText === undefined;
  if (!empty && emptyChannelConfirmation !== "") {
    throw new Error(
      `the ${channel} channel already serves a pointer; continue from it without an empty-channel confirmation`,
    );
  }
  if (empty && emptyChannelConfirmation !== HANDHELD_EMPTY_CHANNEL_CONFIRMATION) {
    throw new Error(
      `the ${channel} channel serves no latest.json; terminals already run ` +
        `${HANDHELD_EMPTY_CHANNEL_CONFIRMATION}, so confirm continuing after it with ` +
        `"${HANDHELD_EMPTY_CHANNEL_CONFIRMATION}" or restore the pointer`,
    );
  }
  const current = empty
    ? HANDHELD_LAST_DISTRIBUTED
    : parseHandheldManifest(publishedText, { channel });
  const versionCode = current.versionCode + 1;
  if (versionCode > MAX_VERSION_CODE) throw new Error("versionCode has run out of Android int");
  if (versionCode <= HANDHELD_LAST_DISTRIBUTED.versionCode) {
    throw new Error(
      `versionCode ${versionCode} would not upgrade terminals running ${HANDHELD_EMPTY_CHANNEL_CONFIRMATION}`,
    );
  }
  return { versionName: bumpHandheldVersion(current.versionName, bump), versionCode };
}
