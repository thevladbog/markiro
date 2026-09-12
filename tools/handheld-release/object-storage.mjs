import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import process from "node:process";

import { assertHandheldChannel, HANDHELD_PUBLIC_BASE_URL } from "./manifest.mjs";

/** The handheld shares the Station's bucket, so every key passes this guard first. */
export const HANDHELD_PREFIX = "handheld/";

const YANDEX_S3_ENDPOINT = "https://storage.yandexcloud.net";
const APK_CONTENT_TYPE = "application/vnd.android.package-archive";
const MUTABLE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const SHA256_METADATA = "handheld-sha256";

export function assertHandheldKey(key) {
  if (typeof key !== "string" || !key.startsWith(HANDHELD_PREFIX) || key.includes("..")) {
    throw new Error(`object key must live under ${HANDHELD_PREFIX}: ${String(key)}`);
  }
  return key;
}

export function handheldApkName(versionName) {
  return `markiro-tsd-${versionName}.apk`;
}

export function handheldObjectKey({ channel, versionName, filename }) {
  assertHandheldChannel(channel);
  return assertHandheldKey(`handheld/${channel}/releases/${versionName}/${filename}`);
}

/** The pointer a terminal polls. Moved last, and the only mutable key here. */
export function handheldManifestKey(channel) {
  return assertHandheldKey(`handheld/${assertHandheldChannel(channel)}/latest.json`);
}

export function handheldPublicUrl(key) {
  return `${HANDHELD_PUBLIC_BASE_URL}/${assertHandheldKey(key)}`;
}

export function contentTypeFor(filename) {
  if (filename.endsWith(".apk")) return APK_CONTENT_TYPE;
  if (filename.endsWith(".json")) return "application/json";
  return "text/plain; charset=utf-8";
}

export function createHandheldObjectStore({ env = process.env, Client = S3Client } = {}) {
  if (env.YANDEX_STATION_RELEASE_ENDPOINT !== YANDEX_S3_ENDPOINT) {
    throw new Error(`unexpected object storage endpoint; expected ${YANDEX_S3_ENDPOINT}`);
  }
  const bucket = env.YANDEX_STATION_RELEASE_BUCKET;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? "") || bucket.includes("..")) {
    throw new Error("YANDEX_STATION_RELEASE_BUCKET is not a usable bucket name");
  }
  const accessKeyId = env.YANDEX_STATION_RELEASE_ACCESS_KEY_ID;
  const secretAccessKey = env.YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("object storage credential is missing");
  const client = new Client({
    endpoint: YANDEX_S3_ENDPOINT,
    region: "ru-central1",
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    bucket,
    head: (key) => headHandheldObject({ client, bucket, key }),
    putImmutable: (key, body, contentType, expectedSha256) =>
      putHandheldImmutableObject({ client, bucket, key, body, contentType, expectedSha256 }),
    put: (key, body, contentType) => putHandheldObject({ client, bucket, key, body, contentType }),
  };
}

export async function headHandheldObject({ client, bucket, key }) {
  assertHandheldKey(key);
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const value = response.Metadata?.[SHA256_METADATA];
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`published handheld object has no trusted checksum metadata: ${key}`);
    }
    return value;
  } catch (error) {
    if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

export async function putHandheldImmutableObject({
  client,
  bucket,
  key,
  body,
  contentType,
  expectedSha256,
}) {
  assertHandheldKey(key);
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(`immutable handheld checksum does not match bytes: ${key}`);
  }
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: IMMUTABLE_CACHE_CONTROL,
      Metadata: { [SHA256_METADATA]: expectedSha256 },
    }),
  );
}

export async function putHandheldObject({ client, bucket, key, body, contentType }) {
  assertHandheldKey(key);
  const sha256 = createHash("sha256").update(body).digest("hex");
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: MUTABLE_CACHE_CONTROL,
      Metadata: { [SHA256_METADATA]: sha256 },
    }),
  );
}

/**
 * Reads the object back over the public URL a terminal will use, not over the
 * S3 API: a put that succeeded says nothing about what a device fetches.
 */
export async function verifyPublishedObject({ url, expectedSha256, fetchImpl = fetch }) {
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`published object is not readable: ${url} returned ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      `published object does not match what was uploaded: ${url} (${actual} != ${expectedSha256})`,
    );
  }
}
