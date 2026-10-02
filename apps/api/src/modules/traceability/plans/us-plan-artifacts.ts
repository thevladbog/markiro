import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { OnModuleDestroy } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assertUsPlanArtifactStorageConfig,
  type UsPlanArtifactStorageConfig,
} from "./us-plan-artifact-config";
import type { UsPlanPdfResult } from "./us-plan-pdf";

type ArtifactCommand =
  PutObjectCommand | GetObjectCommand | DeleteObjectCommand | HeadObjectCommand;
export interface UsPlanArtifactS3Transport {
  send(command: ArtifactCommand, options: { abortSignal: AbortSignal }): Promise<unknown>;
  destroy?(): void;
}

const MAX_PDF_BYTES = 8_000_000;
const OPERATION_TIMEOUT_MS = 15_000;
const scopeSchema = z.object({ tenantId: z.uuid(), versionId: z.uuid() }).strict();
type Scope = z.infer<typeof scopeSchema>;
const evidenceSchema = z
  .object({
    objectKey: z.string().max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().min(1).max(MAX_PDF_BYTES),
    rendererVersion: z.literal("us-plan-pdf-v1"),
    contentType: z.literal("application/pdf"),
  })
  .strict();
export type UsPlanArtifactEvidence = Readonly<z.infer<typeof evidenceSchema>>;

/** Object identity, not these visible fields, is the authority for upload/cleanup. */
export interface UsPlanArtifactAttempt {
  readonly artifact: UsPlanArtifactEvidence;
}

/**
 * The caller MUST hold its tenant/publication DB lock, check the exact key against
 * committed plan references, permanently fence this losing attempt against
 * publication, and invoke remove only while that lock is held.
 * An unknown commit outcome is never sufficient evidence of non-reference.
 */
export type UsPlanArtifactCleanupGuard = (
  artifact: UsPlanArtifactEvidence,
  remove: () => Promise<void>,
) => Promise<"referenced" | "deleted">;

interface AttemptRecord {
  scope: Readonly<Scope>;
  artifact: UsPlanArtifactEvidence;
  bytes: Buffer;
  status:
    | "new"
    | "uploading"
    | "uncertain"
    | "created"
    | "verifying"
    | "verified"
    | "referenced"
    | "abandoned"
    | "deleted";
  cleaning: boolean;
}

/** Private US-only internal adapter; grants no tenant authorization or HTTP route. */
export class UsPlanArtifactStore implements OnModuleDestroy {
  readonly #client: UsPlanArtifactS3Transport;
  readonly #ownsClient: boolean;
  readonly #attempts = new WeakMap<UsPlanArtifactAttempt, AttemptRecord>();

  constructor(
    private readonly config: UsPlanArtifactStorageConfig,
    client?: UsPlanArtifactS3Transport,
  ) {
    assertUsPlanArtifactStorageConfig(config);
    this.#ownsClient = client === undefined;
    this.#client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        maxAttempts: 1,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        requestHandler: new NodeHttpHandler({
          connectionTimeout: 3_000,
          requestTimeout: OPERATION_TIMEOUT_MS,
          socketTimeout: 10_000,
          throwOnRequestTimeout: true,
        }),
      });
  }

  onModuleDestroy(): void {
    if (this.#ownsClient) this.#client.destroy?.();
  }

  createAttempt(scope: Scope, pdf: UsPlanPdfResult): UsPlanArtifactAttempt {
    assertScope(scope);
    if (
      !(pdf.bytes instanceof Uint8Array) ||
      pdf.bytes.length < 1 ||
      pdf.bytes.length > MAX_PDF_BYTES
    )
      throw new Error("us_plan_artifact_pdf_invalid");
    const bytes = Buffer.from(pdf.bytes);
    const artifact = Object.freeze({
      objectKey: `us/plans/${scope.tenantId}/${scope.versionId}/${randomUUID()}.pdf`,
      sha256: pdf.sha256,
      byteSize: pdf.byteSize,
      rendererVersion: pdf.rendererVersion,
      contentType: "application/pdf" as const,
    });
    if (
      !evidenceSchema.safeParse(artifact).success ||
      bytes.length !== pdf.byteSize ||
      digest(bytes) !== pdf.sha256
    ) {
      throw new Error("us_plan_artifact_pdf_invalid");
    }
    const attempt = Object.freeze({ artifact });
    this.#attempts.set(attempt, {
      scope: Object.freeze({ ...scope }),
      artifact,
      bytes,
      status: "new",
      cleaning: false,
    });
    return attempt;
  }

  async putVerified(attempt: UsPlanArtifactAttempt): Promise<UsPlanArtifactEvidence> {
    const record = this.owned(attempt);
    if (record.status !== "new") throw new Error("us_plan_artifact_attempt_invalid");
    record.status = "uploading";
    try {
      await bounded(async (signal) =>
        this.#client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: record.artifact.objectKey,
            Body: record.bytes,
            ContentType: "application/pdf",
            ContentLength: record.artifact.byteSize,
            IfNoneMatch: "*",
            ChecksumSHA256: Buffer.from(record.artifact.sha256, "hex").toString("base64"),
            Metadata: { sha256: record.artifact.sha256, renderer: record.artifact.rendererVersion },
          }),
          { abortSignal: signal },
        ),
      );
      record.status = "verifying";
    } catch {
      // The provider may have written before the error. Without a confirmed
      // conditional create, this process cannot claim ownership for deletion.
      record.status = "uncertain";
      throw new Error("us_plan_artifact_upload_failed");
    } finally {
      record.bytes = Buffer.alloc(0);
    }
    try {
      await this.readBytes(record.artifact);
      record.status = "verified";
      return record.artifact;
    } catch {
      record.status = "created";
      throw new Error("us_plan_artifact_verification_failed");
    }
  }

  async readVerified(scope: Scope, artifact: UsPlanArtifactEvidence): Promise<Buffer> {
    assertScope(scope);
    const parsed = evidenceSchema.safeParse(artifact);
    if (!parsed.success) throw new Error("us_plan_artifact_evidence_invalid");
    const prefix = `us/plans/${scope.tenantId}/${scope.versionId}/`;
    const suffix = parsed.data.objectKey.slice(prefix.length);
    if (
      !parsed.data.objectKey.startsWith(prefix) ||
      !suffix.endsWith(".pdf") ||
      !z.uuid().safeParse(suffix.slice(0, -4)).success
    ) {
      throw new Error("us_plan_artifact_scope_invalid");
    }
    try {
      return await this.readBytes(parsed.data);
    } catch {
      throw new Error("us_plan_artifact_read_failed");
    }
  }

  /** Call after confirmed publication; the DB guard still protects ambiguous commits. */
  markReferenced(attempt: UsPlanArtifactAttempt): void {
    const record = this.owned(attempt);
    if (record.cleaning || record.status !== "verified")
      throw new Error("us_plan_artifact_attempt_invalid");
    record.status = "referenced";
  }

  async cleanupUnreferenced(
    attempt: UsPlanArtifactAttempt,
    guard: UsPlanArtifactCleanupGuard,
    scope: Scope,
  ): Promise<"deleted" | "referenced" | "not_owned"> {
    assertScope(scope);
    const record = this.owned(attempt);
    if (record.scope.tenantId !== scope.tenantId || record.scope.versionId !== scope.versionId)
      throw new Error("us_plan_artifact_scope_invalid");
    if (record.status === "referenced" || record.status === "deleted") return record.status;
    if (
      record.status !== "created" &&
      record.status !== "verified" &&
      record.status !== "abandoned"
    )
      return "not_owned";
    if (record.cleaning) throw new Error("us_plan_artifact_cleanup_failed");
    record.cleaning = true;
    let guardActive = true;
    let invoked = false;
    let removed = false;
    try {
      const result = await guard(record.artifact, async () => {
        if (
          !guardActive ||
          invoked ||
          !record.cleaning ||
          (record.status !== "created" &&
            record.status !== "verified" &&
            record.status !== "abandoned")
        )
          throw new Error("us_plan_artifact_cleanup_failed");
        invoked = true;
        record.status = "abandoned";
        await bounded(async (signal) => {
          await this.#client.send(
            new DeleteObjectCommand({ Bucket: this.config.bucket, Key: record.artifact.objectKey }),
            { abortSignal: signal },
          );
          try {
            await this.#client.send(
              new HeadObjectCommand({ Bucket: this.config.bucket, Key: record.artifact.objectKey }),
              { abortSignal: signal },
            );
          } catch (error) {
            if (isMissing(error)) return;
            throw error;
          }
          throw new Error("us_plan_artifact_cleanup_failed");
        });
        record.status = "deleted";
        removed = true;
      });
      if (result === "referenced" && !invoked) {
        record.status = "referenced";
        return result;
      }
      if (result === "deleted" && removed) return result;
      throw new Error("us_plan_artifact_cleanup_failed");
    } catch {
      throw new Error("us_plan_artifact_cleanup_failed");
    } finally {
      guardActive = false;
      record.cleaning = false;
    }
  }

  private owned(attempt: UsPlanArtifactAttempt): AttemptRecord {
    const record = this.#attempts.get(attempt);
    if (!record) throw new Error("us_plan_artifact_attempt_invalid");
    return record;
  }

  private async readBytes(artifact: UsPlanArtifactEvidence): Promise<Buffer> {
    return bounded(async (signal) => {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: artifact.objectKey }),
        { abortSignal: signal },
      );
      const body =
        response && typeof response === "object" && "Body" in response ? response.Body : undefined;
      const parsed = z
        .object({
          Body: z.unknown(),
          ContentLength: z.number().int().nonnegative().optional(),
          ContentType: z.string().optional(),
        })
        .safeParse(response);
      const close = () => closeBody(body);
      signal.addEventListener("abort", close, { once: true });
      try {
        if (!parsed.success) throw new Error("us_plan_artifact_evidence_invalid");
        const { ContentLength: size, ContentType: contentType } = parsed.data;
        if (
          contentType !== artifact.contentType ||
          (size !== undefined && size !== artifact.byteSize)
        )
          throw new Error("us_plan_artifact_evidence_invalid");
        const bytes = await readBounded(body, artifact.byteSize, signal);
        if (bytes.length !== artifact.byteSize || digest(bytes) !== artifact.sha256)
          throw new Error("us_plan_artifact_evidence_invalid");
        return bytes;
      } finally {
        signal.removeEventListener("abort", close);
        close();
      }
    });
  }
}

function assertScope(scope: Scope): void {
  if (!scopeSchema.safeParse(scope).success) throw new Error("us_plan_artifact_scope_invalid");
}
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function isMissing(error: unknown): boolean {
  const parsed = z
    .object({
      name: z.string().optional(),
      $metadata: z.object({ httpStatusCode: z.number().optional() }).optional(),
    })
    .safeParse(error);
  return (
    parsed.success &&
    (parsed.data.name === "NoSuchKey" ||
      parsed.data.name === "NotFound" ||
      parsed.data.$metadata?.httpStatusCode === 404)
  );
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("us_plan_artifact_timeout"));
    }, OPERATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

function closeBody(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const closeable = body as { destroy?: () => unknown; cancel?: () => unknown };
  try {
    if (typeof closeable.destroy === "function") closeable.destroy.call(body);
    else if (typeof closeable.cancel === "function")
      void Promise.resolve(closeable.cancel.call(body)).catch(() => {});
  } catch {
    /* Preserve the bounded sanitized error. */
  }
}

async function readBounded(body: unknown, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new Error("us_plan_artifact_size_limit");
    return Buffer.from(body);
  }
  if (
    !body ||
    typeof body !== "object" ||
    !(Symbol.asyncIterator in body) ||
    typeof body[Symbol.asyncIterator] !== "function"
  )
    throw new Error("us_plan_artifact_body_invalid");
  const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let total = 0;
  let chunkCount = 0;
  while (!signal.aborted) {
    const next = await iterator.next();
    if (next.done) return Buffer.concat(chunks, total);
    if (!(next.value instanceof Uint8Array)) throw new Error("us_plan_artifact_body_invalid");
    chunkCount += 1;
    if (chunkCount > 16_384) throw new Error("us_plan_artifact_stream_limit");
    total += next.value.byteLength;
    if (total > maxBytes) throw new Error("us_plan_artifact_size_limit");
    chunks.push(Buffer.from(next.value));
  }
  throw new Error("us_plan_artifact_timeout");
}
