import { z } from "zod";

import { isBadgePhc, isPinPhc } from "../lib/credentials.js";
import { canonicalSaltSchema, templatePurposeSchema, templateSpecSchema } from "./protocol.js";

/**
 * The cloud → standalone import file (plan IMP, pilot spec §8.7) and the
 * `POST /v1/office/import` request built from it. The export tool
 * (`tools/standalone-export`) writes the file; `payload` mirrors
 * `markiro_proto::cloud_import::CloudImportPayload` and is sent as it is.
 * `proto/fixtures/cloud-export-file.json` is the tool's golden output, which
 * both this module's tests and the host's read.
 *
 * The file holds PIN and badge hashes and the badge salt. The caller keeps the
 * parsed file in memory for the length of one import only: it never stores it
 * (no storage, no log, no state that outlives the import) and drops its
 * reference afterwards. Nothing here logs or throws a value: a refusal names
 * its kind, and for a shape problem the path of the field, never the value.
 */

/** Mirrors `markiro_proto::cloud_import::CLOUD_IMPORT_FORMAT_VERSION`. */
export const CLOUD_EXPORT_FORMAT_VERSION = 1;
export const CLOUD_EXPORT_FORMAT = "markiro-cloud-export";

const idSchema = z.uuid();
const groupCodeSchema = z.number().int().nonnegative();
const countSchema = z.number().int().nonnegative().nullable();

/** The payload, exactly as the host's request type reads it: strict at every level. */
export const cloudImportPayloadSchema = z.strictObject({
  organization: z.strictObject({
    name: z.string(),
    inn: z.string().nullable(),
    gln: z.string(),
    gs1Prefixes: z.array(z.string()),
    timeZone: z.string(),
  }),
  badgeSalt: canonicalSaltSchema.nullable(),
  lines: z.array(z.strictObject({ id: idSchema, name: z.string() })),
  counterparties: z.array(
    z.strictObject({
      id: idSchema,
      name: z.string(),
      inn: z.string().nullable(),
      gln: z.string(),
      gs1Prefixes: z.array(z.string()),
    }),
  ),
  templates: z.array(
    z.strictObject({
      id: idSchema,
      name: z.string(),
      purpose: templatePurposeSchema,
      enabled: z.boolean(),
      chzProductGroupCodes: z.array(groupCodeSchema).nullable(),
      spec: templateSpecSchema,
    }),
  ),
  templateDefaults: z.strictObject({
    defaultBoxTemplateId: idSchema.nullable(),
    defaultPalletTemplateId: idSchema.nullable(),
    categories: z.array(
      z.strictObject({
        chzProductGroupCode: groupCodeSchema,
        purpose: templatePurposeSchema,
        templateId: idSchema,
      }),
    ),
  }),
  products: z.array(
    z.strictObject({
      id: idSchema,
      gtin14: z.string(),
      name: z.string(),
      printName: z.string().nullable(),
      chzProductGroupCode: groupCodeSchema.nullable(),
      boxCapacity: countSchema,
      palletBoxCapacity: countSchema,
      shelfLifeDays: countSchema,
      defaultBoxTemplateId: idSchema.nullable(),
      defaultPalletTemplateId: idSchema.nullable(),
      archived: z.boolean(),
    }),
  ),
  operators: z.array(
    z.strictObject({
      id: idSchema,
      login: z.string(),
      name: z.string(),
      role: z.string().nullable(),
      pinPhc: z.string().refine(isPinPhc),
      active: z.boolean(),
    }),
  ),
  badges: z.array(
    z.strictObject({
      id: idSchema,
      operatorId: idSchema,
      badgePhc: z.string().refine(isBadgePhc),
      label: z.string().nullable(),
    }),
  ),
  ssccCounters: z.array(
    z.strictObject({
      issuerPrefix: z.string(),
      extension: z.union([z.literal(0), z.literal(1)]),
      nextSerial: z.number().int().nonnegative(),
    }),
  ),
  shiftNumberCounters: z.array(
    z.strictObject({ monthKey: z.string(), lastSeq: z.number().int().positive() }),
  ),
});
export type CloudImportPayload = z.infer<typeof cloudImportPayloadSchema>;

/** One row of the cut-over table (pilot spec §8.4): what the office shows, nothing it sends. */
export const cutoverCounterSchema = z.strictObject({
  issuerPrefix: z.string(),
  extension: z.union([z.literal(0), z.literal(1)]),
  owner: z.union([
    z.strictObject({ kind: z.literal("organization") }),
    z.strictObject({ kind: z.literal("counterparty"), id: idSchema, name: z.string() }),
    z.strictObject({ kind: z.literal("unknown") }),
  ]),
  issuedMax: z.number().int().nonnegative().nullable(),
  printedMax: z.number().int().nonnegative().nullable(),
  standaloneStart: z.number().int().nonnegative(),
  cloudReseedTo: z.number().int().nonnegative().nullable(),
});
export type CutoverCounter = z.infer<typeof cutoverCounterSchema>;

/**
 * A note of the tool: what it changed or left out. Its fields depend on
 * `code`; the page reads the ones it knows and shows an unknown code as is.
 */
export const exportNoteSchema = z.looseObject({ code: z.string().min(1) });
export type ExportNote = z.infer<typeof exportNoteSchema>;

export const cloudExportFileSchema = z.strictObject({
  format: z.literal(CLOUD_EXPORT_FORMAT),
  formatVersion: z.literal(CLOUD_EXPORT_FORMAT_VERSION),
  tool: z.string(),
  exportedAt: z.iso.datetime(),
  rehearsal: z.boolean(),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  source: z.strictObject({ tenantId: z.string(), tenantName: z.string() }),
  payload: cloudImportPayloadSchema,
  cutover: z.strictObject({
    boxWindow: z.number().int().positive(),
    palletWindow: z.number().int().positive(),
    ssccCounters: z.array(cutoverCounterSchema),
  }),
  notes: z.array(exportNoteSchema),
});
export type CloudExportFile = z.infer<typeof cloudExportFileSchema>;

/** Mirrors `markiro_proto::cloud_import::CloudImportRequest`; a request, so strict. */
export interface CloudImportRequest {
  importId: string;
  dryRun: boolean;
  formatVersion: number;
  exportedAt: string;
  rehearsal: boolean;
  source: { tenantId: string; tenantName: string };
  payload: CloudImportPayload;
}

/** Mirrors `markiro_proto::cloud_import::CloudImportSummary`; a response, so lenient. */
export const cloudImportSummarySchema = z.object({
  dryRun: z.boolean(),
  repeated: z.boolean(),
  linesCreated: z.number().int().nonnegative(),
  linesPresent: z.number().int().nonnegative(),
  counterparties: z.number().int().nonnegative(),
  templates: z.number().int().nonnegative(),
  orgDefaults: z.number().int().nonnegative(),
  categoryDefaults: z.number().int().nonnegative(),
  products: z.number().int().nonnegative(),
  operators: z.number().int().nonnegative(),
  badges: z.number().int().nonnegative(),
  badgeSaltReplaced: z.boolean(),
  ssccCounters: z.array(
    z.object({
      issuerPrefix: z.string(),
      extension: z.number().int(),
      nextSerial: z.number().int(),
    }),
  ),
  shiftNumberCounters: z.array(z.object({ monthKey: z.string(), lastSeq: z.number().int() })),
});
export type CloudImportSummary = z.infer<typeof cloudImportSummarySchema>;

/**
 * Canonical JSON, as the tool's `canonical.mjs` writes it: object keys
 * sorted, no spaces, values as `JSON.stringify` writes them.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `sha256:<hex>` of the file without its `checksum` field, as the tool's `fileChecksum`. */
export async function fileChecksum(file: Record<string, unknown>): Promise<string> {
  const rest = Object.fromEntries(Object.entries(file).filter(([key]) => key !== "checksum"));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(rest)),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `sha256:${hex.join("")}`;
}

/**
 * The largest file the office reads: the host's limit on the import route
 * (32 MiB). A larger one is refused before it is read into memory.
 */
export const MAX_CLOUD_EXPORT_BYTES = 32 * 1024 * 1024;

export type CloudFileProblem = "json" | "format" | "version" | "checksum";

/**
 * `path` (a shape problem only) names the field the schema refused, such as
 * `payload.products.0.gtin14`, never its value; for an unknown field it is the
 * object that holds it.
 */
export type CloudFileRead =
  | { kind: "ok"; file: CloudExportFile }
  | { kind: "problem"; problem: CloudFileProblem; path?: string };

/**
 * A file the office may send: JSON, of this format and version, of the
 * expected shape, with a checksum that matches. The checksum is computed on
 * the parsed value, so whitespace and key order on disk do not matter, and
 * a file damaged on its way (a truncated copy, an edit) is refused before
 * anything reaches the host.
 */
export async function readCloudExportFile(text: string): Promise<CloudFileRead> {
  // A string is never longer than its UTF-8 bytes, so this never refuses a
  // file the byte check of `readCloudExportBlob` lets through.
  if (text.length > MAX_CLOUD_EXPORT_BYTES) return { kind: "problem", problem: "format" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "problem", problem: "json" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "problem", problem: "format" };
  }
  const record = value as Record<string, unknown>;
  if (record.format !== CLOUD_EXPORT_FORMAT) return { kind: "problem", problem: "format" };
  if (record.formatVersion !== CLOUD_EXPORT_FORMAT_VERSION) {
    return { kind: "problem", problem: "version" };
  }
  if ((await fileChecksum(record)) !== record.checksum) {
    return { kind: "problem", problem: "checksum" };
  }
  const parsed = cloudExportFileSchema.safeParse(record);
  if (parsed.success) return { kind: "ok", file: parsed.data };
  // Only the path of the first issue: its message and input would quote the value.
  const path = parsed.error.issues[0]?.path.map(String).join(".");
  return path === undefined || path === ""
    ? { kind: "problem", problem: "format" }
    : { kind: "problem", problem: "format", path };
}

/**
 * Reads a chosen file: the size is checked before the content is read into
 * memory, so a file past `MAX_CLOUD_EXPORT_BYTES` costs nothing.
 */
export async function readCloudExportBlob(blob: Blob): Promise<CloudFileRead> {
  if (blob.size > MAX_CLOUD_EXPORT_BYTES) return { kind: "problem", problem: "format" };
  return readCloudExportFile(await blob.text());
}

/** The request for `file`, every field named. */
export function cloudImportRequest(
  file: CloudExportFile,
  importId: string,
  dryRun: boolean,
): CloudImportRequest {
  return {
    importId,
    dryRun,
    formatVersion: file.formatVersion,
    exportedAt: file.exportedAt,
    rehearsal: file.rehearsal,
    source: { tenantId: file.source.tenantId, tenantName: file.source.tenantName },
    payload: file.payload,
  };
}
