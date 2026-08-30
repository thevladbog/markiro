import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

export const SIGNER_PREFIX = "signer/";
export const SIGNER_MANIFEST_KEY = "signer/stable/latest.json";
export const SIGNER_PUBLIC_BASE_URL = "https://releases.markiro.app";

const YANDEX_S3_ENDPOINT = "https://storage.yandexcloud.net";

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
    put: (key, body, contentType) => putSignerObject({ client, bucket, key, body, contentType }),
  };
}

export async function putSignerObject({ client, bucket, key, body, contentType }) {
  assertSignerKey(key);
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
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
