import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { lstat, readFile } from "node:fs/promises";

import { stationAssetNames } from "./artifacts.mjs";
import { stationReleaseLocation } from "./origins.mjs";

const PUBLIC_BASE_URL = "https://releases.markiro.app";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MUTABLE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const INSTALLER_CONTENT_TYPE = "application/vnd.microsoft.portable-executable";
const SOURCE_KEY_METADATA = "station-source-key";
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

function invalid() {
  throw new Error("invalid station object storage request");
}

function storageFailure() {
  return new Error("station object storage operation failed");
}

function publicFailure() {
  return new Error("station public object read failed");
}

function ensureBucket(bucket) {
  if (
    typeof bucket !== "string" ||
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) ||
    bucket.includes("..")
  ) {
    invalid();
  }
}

function ensureContentType(contentType) {
  if (
    typeof contentType !== "string" ||
    contentType.length === 0 ||
    contentType.length > 128 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(contentType)
  ) {
    invalid();
  }
}

function parseImmutableKey(key) {
  if (typeof key !== "string" || key.includes("\\") || key.includes("..")) invalid();
  const parts = key.split("/");
  if (
    parts.length !== 5 ||
    parts[0] !== "station" ||
    !["beta", "stable"].includes(parts[1]) ||
    parts[2] !== "releases"
  ) {
    invalid();
  }
  const [, channel, , version, assetName] = parts;
  let location;
  let names;
  try {
    location = stationReleaseLocation({ channel, origin: "yandex", version });
    names = stationAssetNames(version);
  } catch {
    invalid();
  }
  if (key !== `${location.immutablePrefix}${assetName}`) invalid();
  if (!Object.values(names).includes(assetName)) invalid();
  return { channel, version, assetName, names };
}

function mutableKind(key) {
  if (key === "station/beta/latest.json") return { channel: "beta", kind: "manifest" };
  if (key === "station/stable/latest.json") return { channel: "stable", kind: "manifest" };
  if (key === "station/beta/download") return { channel: "beta", kind: "installer" };
  if (key === "station/download") return { channel: "stable", kind: "installer" };
  invalid();
}

function ensureReadableKey(key) {
  try {
    return { type: "immutable", ...parseImmutableKey(key) };
  } catch (error) {
    if (error?.message !== "invalid station object storage request") throw error;
  }
  return { type: "mutable", ...mutableKind(key) };
}

function maxBytesForKey(key) {
  const parsed = ensureReadableKey(key);
  if (parsed.kind === "installer") return MAX_ARTIFACT_BYTES;
  if (parsed.type === "immutable") {
    if (parsed.assetName === parsed.names.signature) return MAX_SIGNATURE_BYTES;
    if (parsed.assetName === parsed.names.installer || parsed.assetName === parsed.names.bundle) {
      return MAX_ARTIFACT_BYTES;
    }
  }
  return MAX_TEXT_BYTES;
}

function immutableContentType(parsed) {
  if (parsed.assetName === parsed.names.installer) return INSTALLER_CONTENT_TYPE;
  if (parsed.assetName === parsed.names.bundle) return "application/zip";
  if (parsed.assetName === parsed.names.manifest || parsed.assetName === parsed.names.evidence) {
    return "application/json";
  }
  if (parsed.assetName === parsed.names.notes) return "text/markdown";
  return "text/plain";
}

export async function validateStationImmutableObject({ key, file, contentType } = {}) {
  const parsed = parseImmutableKey(key);
  const maxBytes = maxBytesForKey(key);
  ensureContentType(contentType);
  if (contentType !== immutableContentType(parsed) || typeof file !== "string") invalid();
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) {
      invalid();
    }
  } catch (error) {
    if (error?.message === "invalid station object storage request") throw error;
    invalid();
  }
}

function isMissing(error) {
  return (
    error &&
    typeof error === "object" &&
    (error.name === "NoSuchKey" ||
      error.name === "NotFound" ||
      error.$metadata?.httpStatusCode === 404)
  );
}

async function closeBody(body) {
  if (!body || typeof body !== "object") return;
  try {
    if (typeof body.destroy === "function") await body.destroy();
    else if (typeof body.cancel === "function") await body.cancel();
  } catch {
    // Cleanup errors must not replace the bounded public error.
  }
}

async function readBoundedBody(body, contentLength, maxBytes) {
  if (
    typeof contentLength === "number" &&
    (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxBytes)
  ) {
    await closeBody(body);
    throw storageFailure();
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength === 0 || body.byteLength > maxBytes) throw storageFailure();
    return Buffer.from(body);
  }
  if (!body || typeof body !== "object") throw storageFailure();

  let iterable = body;
  if (!(Symbol.asyncIterator in iterable)) {
    if (typeof body.getReader === "function") {
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
    } else if (typeof body.transformToByteArray === "function") {
      const bytes = await body.transformToByteArray();
      return readBoundedBody(bytes, bytes.byteLength, maxBytes);
    } else {
      throw storageFailure();
    }
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of iterable) {
    if (!(chunk instanceof Uint8Array)) throw storageFailure();
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      await closeBody(body);
      throw storageFailure();
    }
    chunks.push(bytes);
  }
  if (total === 0) throw storageFailure();
  return Buffer.concat(chunks, total);
}

function ensureBytes(bytes, maxBytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    invalid();
  }
}

export function createStationObjectStore({
  client,
  bucket,
  publicBaseUrl,
  fetchImpl = fetch,
} = {}) {
  if (!client || typeof client.send !== "function") invalid();
  ensureBucket(bucket);
  if (publicBaseUrl !== PUBLIC_BASE_URL || typeof fetchImpl !== "function") invalid();

  return Object.freeze({
    async assertAbsent(key) {
      parseImmutableKey(key);
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (isMissing(error)) return;
        throw storageFailure();
      }
      throw new Error("station release object already exists");
    },

    async putImmutable(key, file, contentType) {
      const maxBytes = maxBytesForKey(key);
      await validateStationImmutableObject({ key, file, contentType });
      let bytes;
      try {
        bytes = await readFile(file);
        ensureBytes(bytes, maxBytes);
      } catch (error) {
        if (error?.message === "invalid station object storage request") throw error;
        invalid();
      }
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            CacheControl: IMMUTABLE_CACHE_CONTROL,
            IfNoneMatch: "*",
          }),
        );
      } catch {
        throw storageFailure();
      }
    },

    async getMutable(key) {
      const maxBytes = maxBytesForKey(key);
      mutableKind(key);
      let response;
      try {
        response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (isMissing(error)) return null;
        throw storageFailure();
      }
      try {
        ensureContentType(response.ContentType);
        const sourceKey = response.Metadata?.[SOURCE_KEY_METADATA] ?? null;
        if (
          sourceKey !== null &&
          (typeof sourceKey !== "string" || sourceKey.length === 0 || sourceKey.length > 1024)
        ) {
          throw storageFailure();
        }
        return {
          bytes: await readBoundedBody(response.Body, response.ContentLength, maxBytes),
          contentType: response.ContentType,
          sourceKey,
        };
      } catch {
        await closeBody(response?.Body);
        throw storageFailure();
      }
    },

    async putMutable(key, bytes, contentType) {
      const maxBytes = maxBytesForKey(key);
      mutableKind(key);
      ensureBytes(bytes, maxBytes);
      ensureContentType(contentType);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: Buffer.from(bytes),
            ContentType: contentType,
            CacheControl: MUTABLE_CACHE_CONTROL,
          }),
        );
      } catch {
        throw storageFailure();
      }
    },

    async copyImmutableToAlias({ immutableKey, aliasKey, attachmentFilename } = {}) {
      const immutable = parseImmutableKey(immutableKey);
      const alias = mutableKind(aliasKey);
      if (
        immutable.assetName !== immutable.names.installer ||
        immutable.channel !== alias.channel ||
        alias.kind !== "installer" ||
        attachmentFilename !== immutable.names.installer
      ) {
        invalid();
      }
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: aliasKey,
            CopySource: `${bucket}/${immutableKey}`,
            MetadataDirective: "REPLACE",
            ContentType: INSTALLER_CONTENT_TYPE,
            ContentDisposition: `attachment; filename="${attachmentFilename}"`,
            CacheControl: MUTABLE_CACHE_CONTROL,
            Metadata: { [SOURCE_KEY_METADATA]: immutableKey },
          }),
        );
      } catch {
        throw storageFailure();
      }
    },

    async readPublic(key) {
      const maxBytes = maxBytesForKey(key);
      const url = `${PUBLIC_BASE_URL}/${key}`;
      let response;
      try {
        response = await fetchImpl(url, { redirect: "error", cache: "no-store" });
        if (
          !response?.ok ||
          response.redirected === true ||
          (typeof response.url === "string" && response.url.length > 0 && response.url !== url)
        ) {
          throw publicFailure();
        }
        const lengthText = response.headers?.get?.("content-length");
        const contentLength =
          lengthText === null || lengthText === undefined ? undefined : Number(lengthText);
        return await readBoundedBody(response.body, contentLength, maxBytes);
      } catch {
        await closeBody(response?.body);
        throw publicFailure();
      }
    },
  });
}
