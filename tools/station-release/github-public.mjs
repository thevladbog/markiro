import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { stationAssetNames } from "./artifacts.mjs";
import { isCanonicalAbsolutePath } from "./canonical-path.mjs";
import { stationReleaseLocation } from "./origins.mjs";

const CHANNELS = new Set(["beta", "stable"]);
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_REDIRECT_URL_BYTES = 16 * 1024;
const PUBLIC_READ_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const CHANNEL_MATCH_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 60_000];

function invalid() {
  throw new Error("invalid station GitHub public read");
}

function publicFailure() {
  return new Error("station GitHub public read failed");
}

function retryablePublicFailure() {
  const error = publicFailure();
  Object.defineProperty(error, "retryable", { value: true });
  return error;
}

async function closeBody(body) {
  if (!body || typeof body !== "object") return;
  try {
    if (typeof body.destroy === "function") await body.destroy();
    else if (typeof body.cancel === "function") await body.cancel();
  } catch {
    // Cleanup must not replace the bounded public error.
  }
}

async function readBoundedBody(body, contentLength, maxBytes) {
  if (
    typeof contentLength === "number" &&
    (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxBytes)
  ) {
    await closeBody(body);
    throw publicFailure();
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength === 0 || body.byteLength > maxBytes) throw publicFailure();
    return Buffer.from(body);
  }
  if (!body || typeof body !== "object") throw publicFailure();
  let iterable = body;
  if (!(Symbol.asyncIterator in iterable)) {
    if (typeof body.getReader !== "function") throw publicFailure();
    iterable = {
      async *[Symbol.asyncIterator]() {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of iterable) {
    if (!(chunk instanceof Uint8Array)) throw publicFailure();
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      await closeBody(body);
      throw publicFailure();
    }
    chunks.push(bytes);
  }
  if (total === 0) throw publicFailure();
  return Buffer.concat(chunks, total);
}

function ensureChannel(channel) {
  if (!CHANNELS.has(channel)) invalid();
}

function releaseAsset(channel, version, assetName) {
  ensureChannel(channel);
  let location;
  let names;
  try {
    location = stationReleaseLocation({ channel, origin: "github", version });
    names = stationAssetNames(version);
  } catch {
    invalid();
  }
  const allowed = Object.values(names);
  if (typeof assetName !== "string" || !allowed.includes(assetName)) invalid();
  const maxBytes =
    assetName === names.signature
      ? MAX_SIGNATURE_BYTES
      : assetName === names.installer || assetName === names.bundle
        ? MAX_ARTIFACT_BYTES
        : MAX_TEXT_BYTES;
  return {
    url: `${location.releaseBaseUrl}/${assetName}`,
    maxBytes,
  };
}

function channelManifest(channel) {
  ensureChannel(channel);
  const placeholderVersion = channel === "stable" ? "0.0.0" : "0.0.0-beta.1";
  return {
    url: stationReleaseLocation({ channel, origin: "github", version: placeholderVersion })
      .channelUrl,
    maxBytes: MAX_TEXT_BYTES,
  };
}

function validatedRedirect(location) {
  if (
    typeof location !== "string" ||
    location.length === 0 ||
    Buffer.byteLength(location) > MAX_REDIRECT_URL_BYTES
  ) {
    throw publicFailure();
  }
  let url;
  try {
    url = new URL(location);
  } catch {
    throw publicFailure();
  }
  const validPath =
    (url.hostname === "release-assets.githubusercontent.com" &&
      url.pathname.startsWith("/github-production-release-asset/")) ||
    (url.hostname === "objects.githubusercontent.com" &&
      url.pathname.startsWith("/github-production-release-asset-"));
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !validPath
  ) {
    throw publicFailure();
  }
  return url.href;
}

export function createGithubPublicReader({ fetchImpl = fetch, waitImpl = wait } = {}) {
  if (typeof fetchImpl !== "function" || typeof waitImpl !== "function") invalid();

  async function fetchPublic(url, init) {
    try {
      return await fetchImpl(url, init);
    } catch {
      throw retryablePublicFailure();
    }
  }

  async function read(spec) {
    for (let attempt = 0; ; attempt += 1) {
      let initialResponse;
      let assetResponse;
      try {
        initialResponse = await fetchPublic(spec.url, {
          redirect: "manual",
          cache: "no-store",
        });
        if (!initialResponse || initialResponse.status !== 302) {
          throw retryablePublicFailure();
        }
        if (initialResponse.redirected === true) throw publicFailure();
        const location = validatedRedirect(initialResponse.headers?.get?.("location"));
        await closeBody(initialResponse.body);
        assetResponse = await fetchPublic(location, { redirect: "error", cache: "no-store" });
        if (
          assetResponse?.redirected === true ||
          (Number.isInteger(assetResponse?.status) &&
            assetResponse.status >= 300 &&
            assetResponse.status < 400) ||
          (typeof assetResponse?.url === "string" &&
            assetResponse.url.length > 0 &&
            assetResponse.url !== location)
        ) {
          throw publicFailure();
        }
        if (!assetResponse?.ok || assetResponse.status !== 200) {
          throw retryablePublicFailure();
        }
        const lengthText = assetResponse.headers?.get?.("content-length");
        const contentLength =
          lengthText === null || lengthText === undefined ? undefined : Number(lengthText);
        return await readBoundedBody(assetResponse.body, contentLength, spec.maxBytes);
      } catch (error) {
        await closeBody(initialResponse?.body);
        await closeBody(assetResponse?.body);
        if (error?.message === "invalid station GitHub public read") throw error;
        if (error?.retryable !== true || attempt === PUBLIC_READ_RETRY_DELAYS_MS.length) {
          throw publicFailure();
        }
        await waitImpl(PUBLIC_READ_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  async function readChannelMatching(channel, expected) {
    ensureChannel(channel);
    if (!(expected instanceof Uint8Array) || expected.byteLength === 0) invalid();
    if (expected.byteLength > MAX_TEXT_BYTES) invalid();
    const expectedBytes = Buffer.from(expected);
    for (let attempt = 0; ; attempt += 1) {
      const actual = await read(channelManifest(channel));
      if (actual.equals(expectedBytes)) return actual;
      if (attempt === CHANNEL_MATCH_RETRY_DELAYS_MS.length) throw publicFailure();
      await waitImpl(CHANNEL_MATCH_RETRY_DELAYS_MS[attempt]);
    }
  }

  return Object.freeze({
    async readReleaseAsset({ channel, version, assetName } = {}) {
      return read(releaseAsset(channel, version, assetName));
    },

    async readChannelManifest({ channel } = {}) {
      return read(channelManifest(channel));
    },

    async readChannelManifestMatching({ channel, expected } = {}) {
      return readChannelMatching(channel, expected);
    },
  });
}

async function ensureNewDirectory(directory) {
  if (!isCanonicalAbsolutePath(directory)) invalid();
  try {
    await lstat(directory);
    invalid();
  } catch (error) {
    if (error?.message === "invalid station GitHub public read") throw error;
    if (error?.code !== "ENOENT") invalid();
  }
  await mkdir(directory, { mode: 0o700 });
}

async function writeExclusive(path, bytes) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function downloadGithubReleaseTree({ channel, version, directory, reader } = {}) {
  if (!reader || typeof reader.readReleaseAsset !== "function") invalid();
  const names = stationAssetNames(version);
  await ensureNewDirectory(directory);
  try {
    for (const assetName of Object.values(names)) {
      const bytes = await reader.readReleaseAsset({ channel, version, assetName });
      await writeExclusive(join(directory, assetName), bytes);
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function downloadGithubChannelManifest({ channel, outputPath, reader } = {}) {
  if (
    !reader ||
    typeof reader.readChannelManifest !== "function" ||
    !isCanonicalAbsolutePath(outputPath)
  ) {
    invalid();
  }
  try {
    const parent = await lstat(dirname(outputPath));
    if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  } catch (error) {
    if (error?.message === "invalid station GitHub public read") throw error;
    invalid();
  }
  await writeExclusive(outputPath, await reader.readChannelManifest({ channel }));
}

export async function downloadGithubChannelManifestMatching({
  channel,
  expectedPath,
  outputPath,
  reader,
} = {}) {
  if (
    !reader ||
    typeof reader.readChannelManifestMatching !== "function" ||
    !isCanonicalAbsolutePath(expectedPath) ||
    !isCanonicalAbsolutePath(outputPath)
  ) {
    invalid();
  }
  let expected;
  try {
    const [expectedInfo, parent] = await Promise.all([
      lstat(expectedPath),
      lstat(dirname(outputPath)),
    ]);
    if (
      !expectedInfo.isFile() ||
      expectedInfo.isSymbolicLink() ||
      expectedInfo.size <= 0 ||
      expectedInfo.size > MAX_TEXT_BYTES ||
      !parent.isDirectory() ||
      parent.isSymbolicLink()
    ) {
      invalid();
    }
    expected = await readFile(expectedPath);
  } catch (error) {
    if (error?.message === "invalid station GitHub public read") throw error;
    invalid();
  }
  await writeExclusive(outputPath, await reader.readChannelManifestMatching({ channel, expected }));
}

async function main() {
  const [, , command, ...args] = process.argv;
  const reader = createGithubPublicReader();
  if (command === "download-release") {
    const [channel, version, directory, ...extra] = args;
    if (!channel || !version || !directory || extra.length > 0) invalid();
    await downloadGithubReleaseTree({ channel, version, directory, reader });
    return;
  }
  if (command === "download-channel") {
    const [channel, outputPath, ...extra] = args;
    if (!channel || !outputPath || extra.length > 0) invalid();
    await downloadGithubChannelManifest({ channel, outputPath, reader });
    return;
  }
  if (command === "download-channel-exact") {
    const [channel, expectedPath, outputPath, ...extra] = args;
    if (!channel || !expectedPath || !outputPath || extra.length > 0) invalid();
    await downloadGithubChannelManifestMatching({
      channel,
      expectedPath,
      outputPath,
      reader,
    });
    return;
  }
  invalid();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
