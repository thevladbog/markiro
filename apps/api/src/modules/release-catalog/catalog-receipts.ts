import { createHash } from "node:crypto";
import { addAbortSignal } from "node:stream";
import { z } from "zod";
import {
  catalogRevisionSchema,
  channelSnapshotSchema,
  releaseContentTypeSchema,
  releaseIdentitySchema,
  releaseOperationIdSchema,
  releaseSha256Schema,
  releaseVersionIdSchema,
} from "@markiro/platform-contracts";
import { derivePublicPath } from "./catalog-policy";
import type { CatalogStore, ReceiptCursor, ReceiptVersion } from "./catalog-store";
import { CatalogFault } from "./catalog-types";
export const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const scope = channelSnapshotSchema.shape.identity;
const pinned = z
  .object({
    publicPath: z.string().max(512),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    key: z
      .string()
      .max(1024)
      .regex(/^[0-9A-Za-z_./+-]+$/)
      .refine((v) => v.split("/").every((s) => s !== "" && s !== "." && s !== "..")),
    versionId: releaseVersionIdSchema,
    sha256: releaseSha256Schema,
    sizeBytes: z.number().int().positive().max(536870912),
    contentType: releaseContentTypeSchema,
  })
  .strict();
const base = { schema: z.literal(1), id: releaseOperationIdSchema };
const publication = z
  .object({
    ...base,
    kind: z.literal("publication"),
    epoch: releaseOperationIdSchema,
    identity: releaseIdentitySchema,
    requestDigest: releaseSha256Schema,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    files: z.array(pinned).min(1).max(16),
  })
  .strict()
  .superRefine((v, ctx) => {
    const names = new Set<string>();
    let size = 0;
    for (const f of v.files) {
      try {
        const name = f.publicPath.slice(f.publicPath.lastIndexOf("/") + 1);
        if (
          derivePublicPath(v.identity, name) !== f.publicPath ||
          !f.key.startsWith(`${v.identity.product}/`) ||
          names.has(name.toLowerCase())
        )
          throw new Error();
        names.add(name.toLowerCase());
        size += f.sizeBytes;
      } catch {
        ctx.addIssue({ code: "custom", message: "invalid publication binding" });
      }
    }
    if (size > 2147483648) ctx.addIssue({ code: "custom", message: "file set too large" });
  });
const reservationEntry = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("path"),
      version: z.string().max(128),
      publicPath: z.string().max(512),
    })
    .strict(),
  z.object({ kind: z.literal("version"), version: z.string().max(128) }).strict(),
  z.object({ kind: z.literal("range"), upperBound: z.string().max(128) }).strict(),
  z.object({ kind: z.literal("closed") }).strict(),
]);
const reservation = z
  .object({
    ...base,
    kind: z.literal("reservation"),
    epoch: releaseOperationIdSchema,
    identity: scope,
    evidenceSha256: releaseSha256Schema,
    entries: z.array(reservationEntry).min(1).max(1000),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const e of v.entries) {
      if (e.kind === "closed") continue;
      const version = e.kind === "range" ? e.upperBound : e.version;
      const identity = releaseIdentitySchema.safeParse({ ...v.identity, version });
      if (!identity.success) {
        ctx.addIssue({ code: "custom", message: "invalid reservation" });
        continue;
      }
      if (e.kind === "path") {
        try {
          if (
            derivePublicPath(
              identity.data,
              e.publicPath.slice(e.publicPath.lastIndexOf("/") + 1),
            ) !== e.publicPath
          )
            throw new Error();
        } catch {
          ctx.addIssue({ code: "custom", message: "invalid reservation path" });
        }
      }
    }
  });
const pointer = z
  .object({
    base64: z.string().max(87384),
    sha256: releaseSha256Schema,
    sizeBytes: z.number().int().positive().max(65536),
    contentType: z.literal("application/json"),
  })
  .strict()
  .refine((p) => {
    try {
      const b = Buffer.from(p.base64, "base64");
      if (b.toString("base64") !== p.base64 || b.length !== p.sizeBytes || digest(b) !== p.sha256)
        return false;
      const json: unknown = JSON.parse(b.toString("utf8"));
      return json !== null && typeof json === "object" && !Array.isArray(json);
    } catch {
      return false;
    }
  });
const channel = z
  .object({
    ...base,
    kind: z.literal("channel"),
    epoch: releaseOperationIdSchema,
    identity: scope,
    expectedRevision: catalogRevisionSchema,
    revision: catalogRevisionSchema,
    previousPublicationId: releaseOperationIdSchema.nullable(),
    publicationId: releaseOperationIdSchema,
    transition: z.enum(["forward", "rollback"]),
    pointer,
  })
  .strict()
  .refine(
    (v) =>
      BigInt(v.revision) === BigInt(v.expectedRevision) + 1n &&
      (v.expectedRevision === "0"
        ? v.previousPublicationId === null
        : v.previousPublicationId !== null),
  );
export const committedResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("publication"), publicationId: releaseOperationIdSchema }).strict(),
  z
    .object({
      kind: z.literal("channel"),
      publicationId: releaseOperationIdSchema,
      revision: catalogRevisionSchema,
    })
    .strict(),
]);
const confirmation = z
  .object({
    ...base,
    kind: z.literal("confirmation"),
    preparedId: releaseOperationIdSchema,
    preparedSha256: releaseSha256Schema,
    result: committedResultSchema,
  })
  .strict()
  .refine((v) => v.id !== v.preparedId);
export const receiptOperationSchema = z.discriminatedUnion("kind", [
  publication,
  reservation,
  channel,
  confirmation,
]);
export type ReceiptOperation = z.infer<typeof receiptOperationSchema>;
export type PublicationOperation = z.infer<typeof publication>;
export type ReservationOperation = z.infer<typeof reservation>;
export type ChannelOperation = z.infer<typeof channel>;
export function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(v);
  if (encoded === undefined) throw new CatalogFault("invalid_request");
  return encoded;
}
export function operation(input: unknown): ReceiptOperation {
  const result = receiptOperationSchema.safeParse(input);
  if (!result.success) throw new CatalogFault("invalid_request");
  return result.data;
}
export function receiptBytes(input: unknown): Buffer {
  const op = operation(input);
  if (op.kind === "publication")
    op.files.sort((a, b) =>
      a.publicPath < b.publicPath ? -1 : a.publicPath > b.publicPath ? 1 : 0,
    );
  const bytes = Buffer.from(canonical(op));
  if (bytes.length > MAX_RECEIPT_BYTES) throw new CatalogFault("invalid_request");
  return bytes;
}
export function parseReceipt(bytes: Buffer): ReceiptOperation {
  try {
    const input: unknown = JSON.parse(bytes.toString("utf8"));
    const op = operation(input);
    if (!receiptBytes(op).equals(bytes)) throw new Error();
    return op;
  } catch {
    throw new CatalogFault("not_ready");
  }
}
export interface ScanLimits {
  maxPages: number;
  maxRecords: number;
  maxBytes: number;
  timeoutMs: number;
}
export function checkLimits(l: ScanLimits) {
  if (
    ![l.maxPages, l.maxRecords, l.maxBytes, l.timeoutMs].every(
      (v) => Number.isSafeInteger(v) && v > 0,
    ) ||
    l.maxPages > 10000 ||
    l.maxRecords > 100000 ||
    l.maxBytes > 536870912 ||
    l.timeoutMs > 3600000
  )
    throw new CatalogFault("invalid_request");
}
export async function enumerateVersions(
  store: CatalogStore,
  limits: ScanLimits,
): Promise<ReceiptVersion[]> {
  checkLimits(limits);
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const versions: ReceiptVersion[] = [],
    seen = new Set<string>(),
    cursors = new Set<string>();
  let cursor: ReceiptCursor | undefined;
  for (let page = 0; page < limits.maxPages; page++) {
    const result = await bounded(store.listReceiptVersions(cursor, signal), signal);
    for (const v of result.versions) {
      if (
        !v.key.startsWith("_publication-ledger/") ||
        !releaseVersionIdSchema.safeParse(v.versionId).success ||
        typeof v.deleted !== "boolean"
      )
        throw new CatalogFault("not_ready");
      const pair = JSON.stringify([v.key, v.versionId]);
      if (seen.has(pair)) throw new CatalogFault("not_ready");
      seen.add(pair);
      versions.push(v);
      if (versions.length > limits.maxRecords) throw new CatalogFault("not_ready");
    }
    if (!result.nextCursor) return versions;
    const token = JSON.stringify(result.nextCursor);
    if (cursors.has(token)) throw new CatalogFault("not_ready");
    cursors.add(token);
    cursor = result.nextCursor;
  }
  throw new CatalogFault("not_ready");
}
export async function pinnedBytes(
  store: CatalogStore,
  bucket: string,
  v: { key: string; versionId: string },
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const signal = AbortSignal.timeout(timeoutMs);
  const pending = store.readVersion({ bucket, ...v }, signal);
  const body = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
    const aborted = () => reject(new CatalogFault("unavailable"));
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (stream) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) {
          stream.destroy();
          aborted();
        } else resolve(stream);
      },
      () => {
        signal.removeEventListener("abort", aborted);
        reject(new CatalogFault("unavailable"));
      },
    );
  });
  addAbortSignal(signal, body);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array)) throw new CatalogFault("not_ready");
      size += chunk.byteLength;
      if (size > maxBytes) throw new CatalogFault("not_ready");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  } finally {
    body.destroy();
  }
}

async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new CatalogFault("unavailable"));
    if (signal.aborted) {
      pending.catch(() => undefined);
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) aborted();
        else resolve(value);
      },
      () => {
        signal.removeEventListener("abort", aborted);
        reject(new CatalogFault("unavailable"));
      },
    );
  });
}

export function scanDeadline(timeoutMs: number): () => number {
  const deadline = performance.now() + timeoutMs;
  return () => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new CatalogFault("unavailable");
    return remaining;
  };
}
