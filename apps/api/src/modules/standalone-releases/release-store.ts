import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "node:crypto";
import { isMissingObjectError } from "../storage/object-storage.service";
import type { StandaloneReleasesConfig } from "./release-config";

/** A read stopped at its limit: the object is larger than any release file may be. */
export class ReleaseObjectTooLargeError extends Error {
  constructor() {
    super("Release object exceeds its size limit");
  }
}

/**
 * What the release section needs from the public release bucket. Everything is
 * keyed by full object key; the service owns the layout under `standalone/`.
 */
export interface StandaloneReleaseStore {
  /** A short-lived URL the browser PUTs one file to, with exactly `contentType`. */
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  /** The stored size, or `null` when there is no such object. */
  head(key: string): Promise<{ size: number } | null>;
  headVersion(key: string): Promise<{ size: number; versionId: string } | null>;
  /** The whole object, or `null` when missing; above `maxBytes` throws `ReleaseObjectTooLargeError`. */
  read(key: string, maxBytes: number): Promise<Buffer | null>;
  /** SHA-256 and size of the object as streamed back, or `null` when missing. */
  digest(key: string, maxBytes: number): Promise<{ sha256: string; size: number } | null>;
  put(key: string, body: Buffer, contentType: string, cacheControl: string): Promise<void>;
  /** The names of the "folders" directly under `prefix` (which ends with `/`). */
  listFolders(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}

type S3Boundary = Pick<S3Client, "send"> & { destroy?: () => void };
type Presigner = typeof getSignedUrl;

const CONNECTION_TIMEOUT_MS = 3_000;
// A 256 MiB installer is hashed as it streams back: the limit is the idle time
// between packets, not the whole transfer.
const SOCKET_TIMEOUT_MS = 60_000;

export function createReleaseS3Client(config: StandaloneReleasesConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    // Path-style keeps the upload host equal to the endpoint origin, which the
    // admin CSP allows; a dotted bucket name would also break virtual-host TLS.
    forcePathStyle: true,
    // No SDK-added CRC32 on PutObject: in a presigned URL it would be computed
    // over an empty body and make every browser upload fail.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: SOCKET_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    }),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

export class S3StandaloneReleaseStore implements StandaloneReleaseStore {
  readonly #bucket: string;
  readonly #client: S3Boundary;

  constructor(
    config: StandaloneReleasesConfig,
    client?: S3Boundary,
    private readonly presign: Presigner = getSignedUrl,
  ) {
    this.#bucket = config.bucket;
    this.#client = client ?? createReleaseS3Client(config);
  }

  destroy(): void {
    this.#client.destroy?.();
  }

  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return this.presign(
      this.#client as S3Client,
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(["content-type"]) },
    );
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const stored = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return { size: stored.ContentLength ?? 0 };
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  async headVersion(key: string): Promise<{ size: number; versionId: string } | null> {
    if (!/^standalone\/_uploads\/[0-9a-f-]{36}\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(key))
      throw new Error("Invalid staged release key");
    try {
      const result = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      if (!result.VersionId || result.VersionId.toLowerCase() === "null")
        throw new Error("Missing release object version");
      return { size: result.ContentLength ?? 0, versionId: result.VersionId };
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    const size = await this.#stream(key, maxBytes, (chunk) => chunks.push(chunk));
    return size === null ? null : Buffer.concat(chunks, size);
  }

  async digest(key: string, maxBytes: number): Promise<{ sha256: string; size: number } | null> {
    const hash = createHash("sha256");
    const size = await this.#stream(key, maxBytes, (chunk) => hash.update(chunk));
    return size === null ? null : { sha256: hash.digest("hex"), size };
  }

  async put(key: string, body: Buffer, contentType: string, cacheControl: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
  }

  async listFolders(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          Delimiter: "/",
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const entry of page.CommonPrefixes ?? []) {
        const folder = entry.Prefix;
        if (folder?.startsWith(prefix) && folder.endsWith("/"))
          names.push(folder.slice(prefix.length, -1));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return names;
  }

  async remove(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async #stream(
    key: string,
    maxBytes: number,
    onChunk: (chunk: Buffer) => void,
  ): Promise<number | null> {
    let response: { Body?: unknown; ContentLength?: number | undefined };
    try {
      response = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
    const body = response.Body as
      (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    if (typeof response.ContentLength === "number" && response.ContentLength > maxBytes) {
      body?.destroy?.();
      throw new ReleaseObjectTooLargeError();
    }
    if (!body || typeof body[Symbol.asyncIterator] !== "function") {
      throw new Error("Release object body is not readable");
    }
    let size = 0;
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        body.destroy?.();
        throw new ReleaseObjectTooLargeError();
      }
      onChunk(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    return size;
  }
}
