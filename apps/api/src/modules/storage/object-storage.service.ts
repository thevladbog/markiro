import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { OnModuleDestroy } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Env } from "../../env";

type S3Boundary = Pick<S3Client, "send"> & { destroy?: () => void };
type Presigner = typeof getSignedUrl;

const S3_CONNECTION_TIMEOUT_MS = 3_000;
const S3_REQUEST_TIMEOUT_MS = 15_000;
const S3_SOCKET_TIMEOUT_MS = 10_000;

export function createS3Client(env: Env): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
      socketTimeout: S3_SOCKET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    }),
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
}

export class ObjectStorageService implements OnModuleDestroy {
  readonly #bucket: string;
  readonly #client: S3Boundary;
  readonly #ownsClient: boolean;
  readonly #mayCreateBucket: boolean;

  constructor(
    env: Env,
    client?: S3Boundary,
    private readonly presign: Presigner = getSignedUrl,
  ) {
    this.#bucket = env.S3_BUCKET;
    this.#client = client ?? createS3Client(env);
    this.#ownsClient = client === undefined;
    this.#mayCreateBucket = env.NODE_ENV !== "production";
  }

  onModuleDestroy(): void {
    if (this.#ownsClient) this.#client.destroy?.();
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch (error) {
      if (!isMissingBucket(error)) throw error;
      if (!this.#mayCreateBucket) throw error;
      try {
        await this.#client.send(new CreateBucketCommand({ Bucket: this.#bucket }));
      } catch (createError) {
        if (!isBucketCreationRace(createError)) throw createError;
      }
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async putVerified(
    key: string,
    body: Buffer,
    contentType: string,
    sha256: string,
  ): Promise<{ byteSize: number; sha256: string }> {
    assertSafeKey(key);
    assertSha256(sha256);
    const derivedSha256 = createHash("sha256").update(body).digest("hex");
    if (derivedSha256 !== sha256) throw new Error("Object checksum does not match body");
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: { sha256: derivedSha256 },
      }),
    );

    const stored = await this.#client.send(
      new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
    const byteSize = stored.ContentLength;
    const storedSha256 = stored.Metadata?.sha256;
    if (byteSize !== body.byteLength || storedSha256 !== derivedSha256) {
      throw new Error("Object upload verification failed");
    }

    return { byteSize, sha256: derivedSha256 };
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async presignRead(
    key: string,
    expiresInSeconds = 300,
    options?: { downloadFilename: string },
  ): Promise<string> {
    assertSafeKey(key);
    if (expiresInSeconds < 1 || expiresInSeconds > 300) {
      throw new Error("Signed object reads must expire within five minutes");
    }
    return this.presign(
      this.#client as S3Client,
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        ...(options === undefined
          ? {}
          : {
              ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeRfc5987Filename(
                options.downloadFilename,
              )}`,
            }),
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}

function assertSha256(sha256: string): void {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("Invalid SHA-256 checksum");
  }
}

function encodeRfc5987Filename(filename: string): string {
  if (/[\r\n]/.test(filename)) {
    throw new Error("Download filename must not contain CR or LF");
  }
  return encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function assertSafeKey(key: string): void {
  if (
    (!key.startsWith("users/") && !key.startsWith("tenants/")) ||
    key.includes("..") ||
    key.includes("\\") ||
    key.includes("//") ||
    key.startsWith("/")
  ) {
    throw new Error("Unsafe object key");
  }
}

function isMissingBucket(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === "NotFound" || value.$metadata?.httpStatusCode === 404;
}

function isBucketCreationRace(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists";
}
