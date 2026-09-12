/**
 * The contract between the release workflow and the terminal.
 *
 * Both sides refuse a manifest they do not fully recognise. A terminal that
 * guessed at a half-understood manifest would install something nobody chose,
 * and a workflow that published one would not find out until a factory did.
 */

export const HANDHELD_PUBLIC_BASE_URL = "https://releases.markiro.app";

/** `stable` is what terminals poll; `beta` exists so adding it later moves nothing. */
export const HANDHELD_CHANNELS = ["stable", "beta"];

const MANIFEST_KEYS = "bytes,notes,releasedAt,sha256,sourceSha,url,versionCode,versionName";
const VERSION_NAME = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** `versionCode` is an Android int: the installer compares it and nothing else. */
const MAX_VERSION_CODE = 2 ** 31 - 1;

function invalid(what) {
  throw new Error(`invalid handheld manifest: ${what}`);
}

export function assertHandheldChannel(channel) {
  if (!HANDHELD_CHANNELS.includes(channel)) {
    throw new Error(`unknown handheld channel: ${String(channel)}`);
  }
  return channel;
}

export function handheldChannelBaseUrl(channel) {
  return `${HANDHELD_PUBLIC_BASE_URL}/handheld/${assertHandheldChannel(channel)}`;
}

export function assertValidHandheldManifest(manifest, { channel = "stable" } = {}) {
  assertHandheldChannel(channel);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    invalid("not an object");
  if (Object.keys(manifest).sort().join(",") !== MANIFEST_KEYS) invalid("unexpected field set");

  const { versionName, versionCode, sha256, bytes, url, notes, releasedAt, sourceSha } = manifest;
  if (typeof versionName !== "string" || !VERSION_NAME.test(versionName)) invalid("versionName");
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
    invalid("versionCode");
  }
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) invalid("sha256");
  if (!Number.isInteger(bytes) || bytes < 1) invalid("bytes");
  if (typeof sourceSha !== "string" || !COMMIT.test(sourceSha)) invalid("sourceSha");
  if (typeof notes !== "string" || notes.trim().length === 0) invalid("notes");
  if (typeof releasedAt !== "string" || Number.isNaN(Date.parse(releasedAt))) invalid("releasedAt");
  // Not merely https and not merely the right host: the artifact a channel
  // points at has to live inside that channel, or `stable` could be pointed at
  // an unaccepted `beta` build by a single mistyped input.
  if (typeof url !== "string" || !url.startsWith(`${handheldChannelBaseUrl(channel)}/`)) {
    invalid("url is outside the channel it is published to");
  }
  return manifest;
}

export function buildHandheldManifest({
  versionName,
  versionCode,
  sha256,
  bytes,
  url,
  notes,
  releasedAt,
  sourceSha,
  channel = "stable",
}) {
  return assertValidHandheldManifest(
    { versionName, versionCode, sha256, bytes, url, notes, releasedAt, sourceSha },
    { channel },
  );
}

export function parseHandheldManifest(text, { channel = "stable" } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid("not JSON");
  }
  return assertValidHandheldManifest(parsed, { channel });
}

/**
 * A published channel may only move forward.
 *
 * An unreadable current manifest is an error, never «assume nothing is
 * published»: that reading would let a lower `versionCode` through, and every
 * installed terminal would silently refuse the update.
 */
export function assertSupersedes(publishedText, next, { channel = "stable" } = {}) {
  assertValidHandheldManifest(next, { channel });
  if (publishedText === null || publishedText === undefined) return next;
  const published = parseHandheldManifest(publishedText, { channel });
  if (next.versionCode <= published.versionCode) {
    throw new Error(
      `versionCode must grow: ${published.versionCode} is published, ${next.versionCode} was offered`,
    );
  }
  return next;
}
