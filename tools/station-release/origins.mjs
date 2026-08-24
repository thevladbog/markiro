import { parseStationBetaTag, parseStationStableTag } from "./version.mjs";

const CHANNELS = new Set(["beta", "stable"]);
const ORIGINS = new Set(["github", "yandex"]);
const GITHUB_RELEASES = new URL("https://github.com/thevladbog/markiro/releases/download/");
const YANDEX_RELEASES = new URL("https://releases.markiro.app/");

function invalid() {
  throw new Error("invalid station release origin");
}

function ensureChannelVersion(channel, version) {
  if (typeof version !== "string" || !CHANNELS.has(channel)) invalid();
  const parsed =
    channel === "beta"
      ? parseStationBetaTag(`station-v${version}`)
      : parseStationStableTag(`station-v${version}`);
  if (!parsed || parsed.text !== version) invalid();
}

function releaseUrl(base, path) {
  return new URL(path, base).href;
}

export function stationReleaseLocation(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "channel,origin,version"
  ) {
    invalid();
  }
  const { channel, origin, version } = input;
  ensureChannelVersion(channel, version);
  if (!ORIGINS.has(origin)) invalid();

  if (origin === "github") {
    return Object.freeze({
      origin,
      channelUrl: releaseUrl(GITHUB_RELEASES, `station-${channel}-channel/latest.json`),
      releaseBaseUrl: releaseUrl(GITHUB_RELEASES, `station-v${version}`),
      immutablePrefix: null,
      mutableManifestKey: null,
      mutableInstallerKey: null,
    });
  }

  return Object.freeze({
    origin,
    channelUrl: releaseUrl(YANDEX_RELEASES, `station/${channel}/latest.json`),
    releaseBaseUrl: releaseUrl(YANDEX_RELEASES, `station/${channel}/releases/${version}`),
    immutablePrefix: `station/${channel}/releases/${version}/`,
    mutableManifestKey: `station/${channel}/latest.json`,
    mutableInstallerKey: channel === "beta" ? "station/beta/download" : "station/download",
  });
}
