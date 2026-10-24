import { createHash } from "node:crypto";
import { Readable, addAbortSignal } from "node:stream";
import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandInput,
  type ListObjectVersionsCommandInput,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { releaseOperationIdSchema, releaseVersionIdSchema } from "@markiro/platform-contracts";
import type { CatalogStorageConfig } from "./catalog-config";
import { CatalogFault } from "./catalog-types";
export interface VersionTarget {
  bucket: string;
  key: string;
  versionId: string;
}
export interface ReceiptCursor {
  key: string;
  versionId: string;
}
export interface ReceiptVersion extends ReceiptCursor {
  deleted: boolean;
}
export interface CatalogTransport {
  get(
    input: GetObjectCommandInput,
    signal: AbortSignal,
  ): Promise<{
    body: Readable;
    versionId: string | undefined;
    contentLength: number | undefined;
    deleted?: boolean | undefined;
  }>;
  put(
    input: PutObjectCommandInput,
    signal: AbortSignal,
  ): Promise<{ versionId: string | undefined }>;
  list(
    input: ListObjectVersionsCommandInput,
    signal: AbortSignal,
  ): Promise<{
    versions: { key: string | undefined; versionId: string | undefined; deleted: boolean }[];
    truncated: boolean | undefined;
    nextKeyMarker?: string | undefined;
    nextVersionIdMarker?: string | undefined;
  }>;
  destroy?(): void;
}
export interface CatalogStore {
  readVersion(target: VersionTarget, signal: AbortSignal): Promise<Readable>;
  writeReceipt(operationId: string, bytes: Buffer): Promise<{ key: string; versionId: string }>;
  listReceiptVersions(
    cursor?: ReceiptCursor,
  ): Promise<{ versions: ReceiptVersion[]; nextCursor: ReceiptCursor | undefined }>;
}
function sdkTransport(config: CatalogStorageConfig): CatalogTransport {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 3000,
      socketTimeout: 60000,
      requestTimeout: 60000,
      throwOnRequestTimeout: true,
    }),
  });
  return {
    async get(input, signal) {
      const r = await client.send(new GetObjectCommand(input), { abortSignal: signal });
      if (!(r.Body instanceof Readable)) throw new CatalogFault("unavailable");
      return {
        body: r.Body,
        versionId: r.VersionId,
        contentLength: r.ContentLength,
        deleted: r.DeleteMarker,
      };
    },
    async put(input, signal) {
      const r = await client.send(new PutObjectCommand(input), { abortSignal: signal });
      return { versionId: r.VersionId };
    },
    async list(input, signal) {
      const r = await client.send(new ListObjectVersionsCommand(input), { abortSignal: signal });
      return {
        versions: [
          ...(r.Versions ?? []).map((v) => ({
            key: v.Key,
            versionId: v.VersionId,
            deleted: false,
          })),
          ...(r.DeleteMarkers ?? []).map((v) => ({
            key: v.Key,
            versionId: v.VersionId,
            deleted: true,
          })),
        ],
        truncated: r.IsTruncated,
        nextKeyMarker: r.NextKeyMarker,
        nextVersionIdMarker: r.NextVersionIdMarker,
      };
    },
    destroy() {
      client.destroy();
    },
  };
}
function version(value: unknown): string {
  const r = releaseVersionIdSchema.safeParse(value);
  if (!r.success) throw new CatalogFault("unavailable");
  return r.data;
}
function safeKey(key: string) {
  return (
    Buffer.byteLength(key) <= 1024 &&
    /^(station|handheld|standalone|signer|_publication-ledger)\/[0-9A-Za-z_./+-]+$/.test(key) &&
    key.split("/").every((s) => s !== "." && s !== ".." && s !== "")
  );
}
const RECEIPT_LIMIT = 2 * 1024 * 1024;
export class S3CatalogStore implements CatalogStore {
  private readonly transport: CatalogTransport;
  constructor(
    private readonly config: CatalogStorageConfig,
    transport?: CatalogTransport,
  ) {
    this.transport = transport ?? sdkTransport(config);
  }
  destroy() {
    this.transport.destroy?.();
  }
  async readVersion(target: VersionTarget, signal: AbortSignal): Promise<Readable> {
    if (target.bucket !== this.config.bucket || !safeKey(target.key))
      throw new CatalogFault("invalid_request");
    const id = version(target.versionId);
    try {
      const r = await this.transport.get(
        { Bucket: this.config.bucket, Key: target.key, VersionId: id },
        signal,
      );
      if (
        r.versionId !== id ||
        r.deleted ||
        !Number.isSafeInteger(r.contentLength) ||
        (r.contentLength ?? -1) < 0
      ) {
        r.body.destroy();
        throw new CatalogFault("unavailable");
      }
      return addAbortSignal(signal, r.body);
    } catch {
      throw new CatalogFault("unavailable");
    }
  }
  async writeReceipt(operationId: string, bytes: Buffer) {
    const parsed = releaseOperationIdSchema.safeParse(operationId);
    if (!parsed.success || !bytes.length || bytes.length > RECEIPT_LIMIT)
      throw new CatalogFault("invalid_request");
    const key = `_publication-ledger/${parsed.data}.json`,
      signal = AbortSignal.timeout(60000);
    try {
      const r = await this.transport.put(
        {
          Bucket: this.config.bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: "application/json",
          ContentMD5: createHash("md5").update(bytes).digest("base64"),
          IfNoneMatch: "*",
        },
        signal,
      );
      const versionId = version(r.versionId),
        body = await this.readVersion({ bucket: this.config.bucket, key, versionId }, signal);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array)) throw new CatalogFault("unavailable");
        size += chunk.byteLength;
        if (size > bytes.length) {
          body.destroy();
          throw new CatalogFault("unavailable");
        }
        hash.update(chunk);
      }
      if (
        size !== bytes.length ||
        hash.digest("hex") !== createHash("sha256").update(bytes).digest("hex")
      )
        throw new CatalogFault("unavailable");
      return { key, versionId };
    } catch {
      throw new CatalogFault("unavailable");
    }
  }
  async listReceiptVersions(cursor?: ReceiptCursor) {
    if (cursor && (!cursor.key.startsWith("_publication-ledger/") || !safeKey(cursor.key)))
      throw new CatalogFault("invalid_request");
    try {
      const r = await this.transport.list(
        {
          Bucket: this.config.bucket,
          Prefix: "_publication-ledger/",
          MaxKeys: 1000,
          ...(cursor ? { KeyMarker: cursor.key, VersionIdMarker: version(cursor.versionId) } : {}),
        },
        AbortSignal.timeout(60000),
      );
      if (typeof r.truncated !== "boolean" || r.versions.length > 1000)
        throw new CatalogFault("unavailable");
      const versions: ReceiptVersion[] = r.versions.map((v) => {
        if (!v.key || !v.key.startsWith("_publication-ledger/") || !safeKey(v.key))
          throw new CatalogFault("unavailable");
        return { key: v.key, versionId: version(v.versionId), deleted: v.deleted };
      });
      let nextCursor: ReceiptCursor | undefined;
      if (r.truncated) {
        if (
          !r.nextKeyMarker ||
          !safeKey(r.nextKeyMarker) ||
          !r.nextKeyMarker.startsWith("_publication-ledger/")
        )
          throw new CatalogFault("unavailable");
        nextCursor = { key: r.nextKeyMarker, versionId: version(r.nextVersionIdMarker) };
        if (
          cursor &&
          (nextCursor.key < cursor.key ||
            (nextCursor.key === cursor.key && nextCursor.versionId === cursor.versionId))
        )
          throw new CatalogFault("unavailable");
      }
      return { versions, nextCursor };
    } catch {
      throw new CatalogFault("unavailable");
    }
  }
}
