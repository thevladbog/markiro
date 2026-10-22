import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "node:crypto";
import {
  assertUsRequestPackageArtifactStorageConfig,
  type UsRequestPackageArtifactStorageConfig,
} from "./us-request-package-artifact-config";
import {
  parseUsWorkerScope,
  parseUsWorkerObjectEvidence,
  type UsWorkerScope,
  type UsWorkerObjectEvidence,
  type UsWorkerFailureCode,
} from "./us-request-worker-types";
export interface UsRequestPackageArtifactS3Transport {
  send(
    command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand | HeadObjectCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<unknown>;
  destroy?(): void;
}
const OPERATION_TIMEOUT_MS = 15_000;
export function projectUsRequestPackageTransportWitness(value: unknown) {
  return (
    [
      "await_send:code:ECONNRESET",
      "consume_body:code:ECONNRESET",
      "await_send:code:ECONNREFUSED",
      "consume_body:code:ECONNREFUSED",
      "await_send:code:ETIMEDOUT",
      "consume_body:code:ETIMEDOUT",
      "await_send:code:EPIPE",
      "consume_body:code:EPIPE",
      "await_send:code:ENETUNREACH",
      "consume_body:code:ENETUNREACH",
      "await_send:code:EHOSTUNREACH",
      "consume_body:code:EHOSTUNREACH",
      "await_send:name:TimeoutError",
      "consume_body:name:TimeoutError",
      "await_send:name:RequestTimeout",
      "consume_body:name:RequestTimeout",
      "await_send:status:408",
      "consume_body:status:408",
      "await_send:status:429",
      "consume_body:status:429",
      "await_send:status:500",
      "consume_body:status:500",
      "await_send:status:502",
      "consume_body:status:502",
      "await_send:status:503",
      "consume_body:status:503",
      "await_send:status:504",
      "consume_body:status:504",
    ] as const
  ).find((witness) => witness === value);
}
type TransportWitness = NonNullable<ReturnType<typeof projectUsRequestPackageTransportWitness>>;
const transportWitnesses = new WeakMap<object, TransportWitness>();
const readStages = new WeakMap<object, "await_send" | "consume_body">();
export function takeUsRequestPackageTransportWitness(error: unknown) {
  if ((!error || typeof error !== "object") && typeof error !== "function") return undefined;
  const witness = transportWitnesses.get(error);
  transportWitnesses.delete(error);
  return witness;
}
interface TransportCapture {
  phase: "await_send" | "consume_body" | undefined;
  witness?: TransportWitness;
}
/** Called only after the original matcher branch succeeds; no error reads. */
function captureTransportMatch(
  capture: TransportCapture | undefined,
  field: "code" | "name" | "status",
  value: unknown,
): true {
  try {
    if (!capture?.phase) return true;
    if (field === "code")
      switch (value) {
        case "ECONNRESET":
          capture.witness =
            capture.phase === "await_send"
              ? "await_send:code:ECONNRESET"
              : "consume_body:code:ECONNRESET";
          break;
        case "ECONNREFUSED":
          capture.witness =
            capture.phase === "await_send"
              ? "await_send:code:ECONNREFUSED"
              : "consume_body:code:ECONNREFUSED";
          break;
        case "ETIMEDOUT":
          capture.witness =
            capture.phase === "await_send"
              ? "await_send:code:ETIMEDOUT"
              : "consume_body:code:ETIMEDOUT";
          break;
        case "EPIPE":
          capture.witness =
            capture.phase === "await_send" ? "await_send:code:EPIPE" : "consume_body:code:EPIPE";
          break;
        case "ENETUNREACH":
          capture.witness =
            capture.phase === "await_send"
              ? "await_send:code:ENETUNREACH"
              : "consume_body:code:ENETUNREACH";
          break;
        case "EHOSTUNREACH":
          capture.witness =
            capture.phase === "await_send"
              ? "await_send:code:EHOSTUNREACH"
              : "consume_body:code:EHOSTUNREACH";
          break;
      }
    if (field === "name")
      switch (value) {
        case "TimeoutError":
          capture.witness =
            capture.phase === "await_send"
              ? "await_send:name:TimeoutError"
              : "consume_body:name:TimeoutError";
          break;
        case "RequestTimeout":
          capture.witness =
            capture.phase === "await_send"
              ? "await_send:name:RequestTimeout"
              : "consume_body:name:RequestTimeout";
          break;
      }
    if (field === "status")
      switch (value) {
        case 408:
          capture.witness =
            capture.phase === "await_send" ? "await_send:status:408" : "consume_body:status:408";
          break;
        case 429:
          capture.witness =
            capture.phase === "await_send" ? "await_send:status:429" : "consume_body:status:429";
          break;
        case 500:
          capture.witness =
            capture.phase === "await_send" ? "await_send:status:500" : "consume_body:status:500";
          break;
        case 502:
          capture.witness =
            capture.phase === "await_send" ? "await_send:status:502" : "consume_body:status:502";
          break;
        case 503:
          capture.witness =
            capture.phase === "await_send" ? "await_send:status:503" : "consume_body:status:503";
          break;
        case 504:
          capture.witness =
            capture.phase === "await_send" ? "await_send:status:504" : "consume_body:status:504";
          break;
      }
  } catch {
    // Best-effort private metadata must never change the original matcher result.
  }
  return true;
}
function closeReadStage(token: object | undefined): void {
  if (token) readStages.delete(token);
}
export function projectUsRequestPackageStorageReadFailureCode(value: unknown) {
  return (
    [
      "us_request_package_storage_scope_invalid",
      "us_request_package_storage_evidence_invalid",
      "us_request_package_storage_timeout",
      "us_request_package_storage_checksum_mismatch",
      "us_request_package_storage_transport_failed",
      "us_request_package_storage_read_failed",
      "us_request_worker_unknown_failure",
    ] as const
  ).find((code) => code === value);
}
const readFailures = new WeakMap<
  object,
  NonNullable<ReturnType<typeof projectUsRequestPackageStorageReadFailureCode>>
>();
/** Factory identity only; never inspect an alleged error or its causes. */
export function takeUsRequestPackageStorageReadFailure(error: unknown) {
  if ((!error || typeof error !== "object") && typeof error !== "function") return undefined;
  const code = readFailures.get(error);
  readFailures.delete(error);
  return code;
}
class StorageError extends Error {
  constructor(readonly code: UsWorkerFailureCode) {
    super(code);
  }
}
const failure = (code: UsWorkerFailureCode) => {
  const error = new StorageError(code);
  const readCode = projectUsRequestPackageStorageReadFailureCode(code);
  if (readCode) readFailures.set(error, readCode);
  return error;
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Internal synthetic adapter. Its scope checks grant no user or deletion authority. */
export class UsRequestPackageArtifactStore {
  readonly #client: UsRequestPackageArtifactS3Transport;
  readonly #ownsClient: boolean;
  readonly #active = new Set<AbortController>();
  #destroyed = false;
  constructor(
    private readonly config: UsRequestPackageArtifactStorageConfig,
    transport?: UsRequestPackageArtifactS3Transport,
  ) {
    assertUsRequestPackageArtifactStorageConfig(config);
    this.#ownsClient = transport === undefined;
    this.#client =
      transport ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        maxAttempts: 1,
        requestHandler: new NodeHttpHandler({
          connectionTimeout: 3_000,
          requestTimeout: OPERATION_TIMEOUT_MS,
          socketTimeout: 10_000,
          throwOnRequestTimeout: true,
        }),
      });
  }

  async putVerified(
    scope: UsWorkerScope,
    evidence: UsWorkerObjectEvidence,
    bytes: Uint8Array,
  ): Promise<void> {
    const artifact = scopedEvidence(scope, evidence);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== artifact.byteSize)
      throw failure("us_request_package_storage_checksum_mismatch");
    // Neither the caller nor later mutation of persisted evidence can change this I/O.
    const copy = Buffer.from(bytes);
    if (digest(copy) !== artifact.sha256)
      throw failure("us_request_package_storage_checksum_mismatch");
    await this.io(async (signal) => {
      try {
        await this.#client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: artifact.objectKey,
            Body: copy,
            ContentType: artifact.mediaType,
            ContentLength: artifact.byteSize,
            IfNoneMatch: "*",
            ChecksumSHA256: Buffer.from(artifact.sha256, "hex").toString("base64"),
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (status(error) === 412 || own(error, "name") === "PreconditionFailed")
          throw failure("us_request_package_storage_collision");
        throw error;
      }
    }, "us_request_worker_unknown_failure");
    // A collision/uncertain PUT never proves ownership and never triggers deletion here.
    await this.readBytes(artifact);
  }

  async readVerified(scope: UsWorkerScope, evidence: UsWorkerObjectEvidence): Promise<Buffer> {
    return this.readBytes(scopedEvidence(scope, evidence));
  }

  /** Task5 must commit its permanent, ownership-checked DB fence before calling.
   * This is an internal I/O seam, not a fence issuer or a user-authorized command. */
  async removeFenced(scope: UsWorkerScope, evidence: UsWorkerObjectEvidence): Promise<void> {
    const artifact = scopedEvidence(scope, evidence);
    await this.io(async (signal) => {
      try {
        await this.#client.send(
          new DeleteObjectCommand({ Bucket: this.config.bucket, Key: artifact.objectKey }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (
          status(error) === 404 ||
          own(error, "name") === "NoSuchKey" ||
          own(error, "name") === "NotFound"
        )
          return;
        throw error;
      }
    }, "us_request_package_storage_delete_failed");
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const controller of this.#active) controller.abort();
    if (this.#ownsClient) this.#client.destroy?.();
  }

  private async readBytes(artifact: UsWorkerObjectEvidence): Promise<Buffer> {
    const readToken = {};
    readStages.set(readToken, "await_send");
    return this.io(
      async (signal) => {
        const response = await this.#client.send(
          new GetObjectCommand({ Bucket: this.config.bucket, Key: artifact.objectKey }),
          { abortSignal: signal },
        );
        if (readStages.has(readToken)) readStages.set(readToken, "consume_body");
        const body = own(response, "Body");
        const close = () => closeBody(body);
        signal.addEventListener("abort", close, { once: true });
        try {
          // A provider may resolve after abort. Close that late body before inspecting it.
          if (signal.aborted) throw failure("us_request_package_storage_timeout");
          const length = own(response, "ContentLength");
          if (
            own(response, "ContentType") !== artifact.mediaType ||
            (length !== undefined && length !== artifact.byteSize)
          )
            throw failure("us_request_package_storage_evidence_invalid");
          const bytes = await readBounded(body, artifact.byteSize, signal);
          if (bytes.length !== artifact.byteSize || digest(bytes) !== artifact.sha256)
            throw failure("us_request_package_storage_checksum_mismatch");
          return bytes;
        } finally {
          signal.removeEventListener("abort", close);
          close();
        }
      },
      "us_request_package_storage_read_failed",
      readToken,
    );
  }

  private async io<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    fallback: UsWorkerFailureCode,
    readToken?: object,
  ): Promise<T> {
    if (this.#destroyed) {
      closeReadStage(readToken);
      throw failure("us_request_worker_unknown_failure");
    }
    const controller = new AbortController();
    this.#active.add(controller);
    const expiresAt = performance.now() + OPERATION_TIMEOUT_MS;
    let rejectAbort: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(failure("us_request_package_storage_timeout"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
    try {
      const result = await Promise.race([operation(controller.signal), deadline]);
      if (controller.signal.aborted || performance.now() >= expiresAt)
        throw failure("us_request_package_storage_timeout");
      return result;
    } catch (error) {
      if (error instanceof StorageError) {
        transportWitnesses.delete(error);
        throw error;
      }
      const capture: TransportCapture = {
        phase: readToken ? readStages.get(readToken) : undefined,
      };
      const transport = isTransportFailure(error, capture);
      const mapped = failure(transport ? "us_request_package_storage_transport_failed" : fallback);
      if (transport && capture.witness) transportWitnesses.set(mapped, capture.witness);
      throw mapped;
    } finally {
      clearTimeout(timer);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
      controller.abort();
      this.#active.delete(controller);
      closeReadStage(readToken);
    }
  }
}

function scopedEvidence(
  scope: UsWorkerScope,
  evidence: UsWorkerObjectEvidence,
): UsWorkerObjectEvidence {
  let parsedScope: UsWorkerScope;
  try {
    parsedScope = parseUsWorkerScope(scope);
  } catch {
    throw failure("us_request_package_storage_scope_invalid");
  }
  let artifact: UsWorkerObjectEvidence;
  try {
    artifact = parseUsWorkerObjectEvidence(evidence);
  } catch {
    throw failure("us_request_package_storage_evidence_invalid");
  }
  if (artifact.tenantId !== parsedScope.tenantId || artifact.runId !== parsedScope.runId)
    throw failure("us_request_package_storage_scope_invalid");
  return artifact;
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function status(error: unknown): unknown {
  return own(own(error, "$metadata"), "httpStatusCode");
}
function isTransportFailure(error: unknown, capture?: TransportCapture): boolean {
  const code = own(error, "code"),
    name = own(error, "name"),
    httpStatus = status(error);
  return (
    (typeof code === "string" &&
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"].includes(
        code,
      ) &&
      captureTransportMatch(capture, "code", code)) ||
    (name === "TimeoutError" && captureTransportMatch(capture, "name", name)) ||
    (name === "RequestTimeout" && captureTransportMatch(capture, "name", name)) ||
    (typeof httpStatus === "number" &&
      [408, 429, 500, 502, 503, 504].includes(httpStatus) &&
      captureTransportMatch(capture, "status", httpStatus))
  );
}
function closeBody(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const closeable = body as { destroy?: () => unknown; cancel?: () => unknown };
  try {
    if (typeof closeable.destroy === "function") closeable.destroy.call(body);
    else if (typeof closeable.cancel === "function")
      void Promise.resolve(closeable.cancel.call(body)).catch(() => {});
  } catch {
    /* Preserve finite boundary errors, never provider content. */
  }
}
async function readBounded(
  body: unknown,
  expectedSize: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (signal.aborted) throw failure("us_request_package_storage_timeout");
    if (body.byteLength > expectedSize)
      throw failure("us_request_package_storage_evidence_invalid");
    return Buffer.from(body);
  }
  if (
    !body ||
    typeof body !== "object" ||
    !(Symbol.asyncIterator in body) ||
    typeof body[Symbol.asyncIterator] !== "function"
  )
    throw failure("us_request_package_storage_evidence_invalid");
  const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  let returned = false;
  const closeIterator = () => {
    if (returned) return;
    returned = true;
    try {
      if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
    } catch {
      /* Never wait past the operation deadline. */
    }
  };
  signal.addEventListener("abort", closeIterator, { once: true });
  // Allocate only the previously validated per-file bound; reject before copying overflow.
  const bytes = Buffer.allocUnsafe(expectedSize);
  let size = 0,
    chunks = 0;
  try {
    while (true) {
      if (signal.aborted) throw failure("us_request_package_storage_timeout");
      const next = await iterator.next();
      if (signal.aborted) throw failure("us_request_package_storage_timeout");
      if (next.done) return bytes.subarray(0, size);
      if (
        !(next.value instanceof Uint8Array) ||
        ++chunks > 16_384 ||
        next.value.byteLength > expectedSize - size
      )
        throw failure("us_request_package_storage_evidence_invalid");
      bytes.set(next.value, size);
      size += next.value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", closeIterator);
    closeIterator();
  }
}
