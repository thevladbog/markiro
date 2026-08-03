import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "../../env";

type S3Boundary = Pick<S3Client, "send">;
type Presigner = typeof getSignedUrl;

export class ObjectStorageService {
  readonly #bucket: string;

  constructor(
    env: Env,
    private readonly client: S3Boundary = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    }),
    private readonly presign: Presigner = getSignedUrl,
  ) {
    this.#bucket = env.S3_BUCKET;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch (error) {
      if (!isMissingBucket(error)) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async presignRead(key: string, expiresInSeconds = 300): Promise<string> {
    assertSafeKey(key);
    if (expiresInSeconds < 1 || expiresInSeconds > 300) {
      throw new Error("Signed object reads must expire within five minutes");
    }
    return this.presign(
      this.client as S3Client,
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
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
