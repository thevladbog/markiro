import { CopyObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

import { signerArtifactNames } from "./version.mjs";

export const SIGNER_PREFIX = "signer/";
export const SIGNER_MANIFEST_KEY = "signer/stable/latest.json";
export const SIGNER_DOWNLOAD_KEY = "signer/download";
export const SIGNER_PUBLIC_BASE_URL = "https://releases.markiro.app";

const YANDEX_S3_ENDPOINT = "https://storage.yandexcloud.net";
const INSTALLER_CONTENT_TYPE = "application/vnd.microsoft.portable-executable";
const MUTABLE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const SOURCE_KEY_METADATA = "signer-source-key";
const SHA256_METADATA = "signer-sha256";

/**
 * The signer shares a bucket with the Station's releases, so every key goes
 * through this guard before it can reach a PutObjectCommand.
 */
export function assertSignerKey(key) {
  if (typeof key !== "string" || !key.startsWith(SIGNER_PREFIX) || key.includes("..")) {
    throw new Error(`object key must live under ${SIGNER_PREFIX}: ${key}`);
  }
}

export function signerObjectKey({ version, filename }) {
  const key = `signer/stable/releases/${version}/${filename}`;
  assertSignerKey(key);
  return key;
}

export function signerPublicUrl(key) {
  assertSignerKey(key);
  return `${SIGNER_PUBLIC_BASE_URL}/${key}`;
}

export function createSignerObjectStore({ env = process.env, Client = S3Client } = {}) {
  if (env.YANDEX_STATION_RELEASE_ENDPOINT !== YANDEX_S3_ENDPOINT) {
    throw new Error(`unexpected object storage endpoint; expected ${YANDEX_S3_ENDPOINT}`);
  }
  const bucket = env.YANDEX_STATION_RELEASE_BUCKET;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? "") || bucket.includes("..")) {
    throw new Error("YANDEX_STATION_RELEASE_BUCKET is not a usable bucket name");
  }
  const accessKeyId = env.YANDEX_STATION_RELEASE_ACCESS_KEY_ID;
  const secretAccessKey = env.YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("object storage credential is missing");
  }
  const client = new Client({
    endpoint: YANDEX_S3_ENDPOINT,
    region: "ru-central1",
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    bucket,
    head: (key) => headSignerObject({ client, bucket, key }),
    putImmutable: (key, body, contentType, expectedSha256) =>
      putSignerImmutableObject({
        client,
        bucket,
        key,
        body,
        contentType,
        expectedSha256,
      }),
    put: (key, body, contentType) => putSignerObject({ client, bucket, key, body, contentType }),
    copyInstallerToDownload: ({ immutableKey, attachmentFilename }) =>
      copySignerInstallerToDownload({
        client,
        bucket,
        immutableKey,
        attachmentFilename,
      }),
  };
}

export async function headSignerObject({ client, bucket, key }) {
  assertSignerKey(key);
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const value = response.Metadata?.[SHA256_METADATA];
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`immutable signer object has no trusted checksum metadata: ${key}`);
    }
    return value;
  } catch (error) {
    if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

export async function putSignerImmutableObject({
  client,
  bucket,
  key,
  body,
  contentType,
  expectedSha256,
}) {
  assertSignerKey(key);
  const actualSha256 = createHash("sha256").update(body).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`immutable signer checksum does not match bytes: ${key}`);
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

export async function putSignerObject({ client, bucket, key, body, contentType }) {
  assertSignerKey(key);
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function copySignerInstallerToDownload({
  client,
  bucket,
  immutableKey,
  attachmentFilename,
}) {
  const parts = typeof immutableKey === "string" ? immutableKey.split("/") : [];
  const version = parts[3];
  const expectedFilename =
    typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)
      ? signerArtifactNames(version).installer
      : null;
  if (
    parts.length !== 5 ||
    parts[0] !== "signer" ||
    parts[1] !== "stable" ||
    parts[2] !== "releases" ||
    parts[4] !== expectedFilename ||
    attachmentFilename !== expectedFilename
  ) {
    throw new Error("download alias source must be the exact stable installer");
  }
  assertSignerKey(immutableKey);
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: SIGNER_DOWNLOAD_KEY,
      CopySource: `${bucket}/${immutableKey}`,
      MetadataDirective: "REPLACE",
      ContentType: INSTALLER_CONTENT_TYPE,
      ContentDisposition: `attachment; filename="${attachmentFilename}"`,
      CacheControl: MUTABLE_CACHE_CONTROL,
      Metadata: { [SOURCE_KEY_METADATA]: immutableKey },
    }),
  );
}

/**
 * Reads the object back over the public URL the agent will use, not over the
 * S3 API: a put that succeeded says nothing about what a client fetches.
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
