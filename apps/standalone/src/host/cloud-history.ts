import { z } from "zod";
import { fileChecksum } from "./cloud-import.js";

export const CLOUD_HISTORY_FORMAT = "markiro-cloud-history";
export const CLOUD_HISTORY_FORMAT_VERSION = 1;
export const MAX_HISTORY_PART_ROWS = 5_000;
export const MAX_HISTORY_PART_BYTES = 4 * 1_048_576;
export const MAX_HISTORY_MANIFEST_BYTES = 1_048_576;
export const MAX_HISTORY_PARTS = 10_000;
export const MAX_HISTORY_REQUEST_BYTES = 8 * 1_048_576;
export const HISTORY_CATEGORIES = [
  "shifts",
  "codes",
  "boxes",
  "items",
  "pallets",
  "owners",
] as const;
const id = z.uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const checksum = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const date = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const nullableInstant = instant.nullable();
export const cloudHistorySourceSchema = z.strictObject({
  tenantId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  tenantName: z.string(),
});
export const cloudHistoryOrganizationSchema = z.strictObject({
  name: z.string(),
  inn: z.string().nullable(),
  gln: z.string(),
  timeZone: z.string(),
});
export const cloudHistoryCountsSchema = z.strictObject({
  shifts: integer,
  codes: integer,
  boxes: integer,
  items: integer,
  pallets: integer,
  owners: integer,
});
export const cloudHistoryShiftSchema = z.strictObject({
  id,
  number: z.string(),
  mode: z.enum(["aggregation", "validation"]),
  productionDate: date.nullable(),
  plannedDate: date.nullable(),
  openedAt: nullableInstant,
  closedAt: nullableInstant,
  productId: id,
  productName: z.string().nullable(),
  gtin14: z.string().regex(/^\d{14}$/),
  lineId: id.nullable(),
  shelfLifeDays: integer.nullable(),
  lineName: z.string().nullable(),
  palletsEnabled: z.boolean(),
  inWindow: z.boolean(),
  createdFrom: z.enum(["admin", "station"]),
  numberMonthKey: z.string(),
  numberSeq: integer,
  createdAt: instant,
  plannedQty: integer.nullable(),
  boxCapacity: integer.nullable(),
  palletBoxCapacity: integer.nullable(),
  counterpartyId: id.nullable(),
  counterpartyName: z.string().nullable(),
  closeReason: z.string().nullable(),
});
export const cloudHistoryCodeSchema = z.strictObject({
  shiftId: id,
  hash,
  canonical: z.string().min(1),
  scannedAt: instant,
  gtin14: z
    .string()
    .regex(/^\d{14}$/)
    .nullable(),
  serial: z.string().nullable(),
  flatOnly: z.boolean(),
});
export const cloudHistoryBoxSchema = z.strictObject({
  id,
  shiftId: id,
  sscc: z.string().nullable(),
  openedAt: instant,
  closedAt: nullableInstant,
  disassembledAt: nullableInstant,
  palletId: id.nullable(),
});
export const cloudHistoryItemSchema = z.strictObject({ boxId: id, hash, addedAt: instant });
export const cloudHistoryPalletSchema = z.strictObject({
  id,
  shiftId: id.nullable(),
  kind: z.enum(["production", "warehouse"]),
  productId: id.nullable(),
  productName: z.string().nullable(),
  gtin14: z
    .string()
    .regex(/^\d{14}$/)
    .nullable(),
  shelfLifeDays: integer.nullable(),
  sscc: z.string().nullable(),
  openedAt: instant,
  closedAt: nullableInstant,
  disassembledAt: nullableInstant,
});
export const cloudHistoryOwnerSchema = z.strictObject({
  hash,
  shiftId: id,
  number: z.string(),
  scannedAt: instant,
  boxId: id.nullable(),
});
export const cloudHistoryPayloadSchema = z
  .strictObject({
    shifts: z.array(cloudHistoryShiftSchema),
    codes: z.array(cloudHistoryCodeSchema),
    boxes: z.array(cloudHistoryBoxSchema),
    items: z.array(cloudHistoryItemSchema),
    pallets: z.array(cloudHistoryPalletSchema),
    owners: z.array(cloudHistoryOwnerSchema),
  })
  .refine(
    (value) =>
      HISTORY_CATEGORIES.reduce((sum, key) => sum + value[key].length, 0) <= MAX_HISTORY_PART_ROWS,
  );
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const cloudHistoryPartSchema = z
  .strictObject({
    index: integer.max(MAX_HISTORY_PARTS - 1),
    payload: cloudHistoryPayloadSchema,
    checksum,
  })
  .refine((value) => jsonBytes(value) <= MAX_HISTORY_PART_BYTES);
export const cloudHistoryManifestSchema = z
  .strictObject({
    format: z.literal(CLOUD_HISTORY_FORMAT),
    formatVersion: z.literal(CLOUD_HISTORY_FORMAT_VERSION),
    exportedAt: instant,
    since: date,
    source: cloudHistorySourceSchema,
    organization: cloudHistoryOrganizationSchema,
    counts: cloudHistoryCountsSchema,
    parts: z
      .array(
        z.strictObject({
          index: integer.max(MAX_HISTORY_PARTS - 1),
          checksum,
          counts: cloudHistoryCountsSchema,
        }),
      )
      .min(1)
      .max(MAX_HISTORY_PARTS),
    checksum,
  })
  .refine(
    (value) =>
      value.parts.every((part, index) => part.index === index) &&
      value.parts.every(
        (part) =>
          HISTORY_CATEGORIES.reduce((sum, key) => sum + part.counts[key], 0) <=
          MAX_HISTORY_PART_ROWS,
      ) &&
      HISTORY_CATEGORIES.every(
        (key) => value.parts.reduce((sum, part) => sum + part.counts[key], 0) === value.counts[key],
      ),
  )
  .refine((value) => jsonBytes(value) <= MAX_HISTORY_MANIFEST_BYTES);
export const cloudHistoryImportRequestSchema = z
  .strictObject({
    manifest: cloudHistoryManifestSchema,
    part: cloudHistoryPartSchema,
    dryRun: z.boolean(),
  })
  .refine((value) => {
    const summary = value.manifest.parts[value.part.index];
    return (
      summary !== undefined &&
      summary.checksum === value.part.checksum &&
      HISTORY_CATEGORIES.every((key) => summary.counts[key] === value.part.payload[key].length) &&
      jsonBytes(value) <= MAX_HISTORY_REQUEST_BYTES
    );
  });
export const cloudHistoryCompleteRequestSchema = z.strictObject({ batchId: checksum });
export const cloudHistoryCancelRequestSchema = cloudHistoryCompleteRequestSchema;
export const cloudHistoryImportStateSchema = z
  .strictObject({
    replacementBackupFile: z.string().optional(),
    batchId: checksum,
    source: cloudHistorySourceSchema,
    status: z.enum(["pending", "complete"]),
    receivedIndices: z.array(integer.max(MAX_HISTORY_PARTS - 1)).max(MAX_HISTORY_PARTS),
    totalParts: integer.min(1).max(MAX_HISTORY_PARTS),
    counts: cloudHistoryCountsSchema,
  })
  .refine(
    (value) =>
      value.receivedIndices.every(
        (index, position) =>
          index < value.totalParts &&
          (position === 0 || index > (value.receivedIndices[position - 1] ?? -1)),
      ) &&
      (value.status !== "complete" || value.receivedIndices.length === value.totalParts),
  );
export type CloudHistoryManifest = z.infer<typeof cloudHistoryManifestSchema>;
export type CloudHistoryPart = z.infer<typeof cloudHistoryPartSchema>;
export type CloudHistoryPayload = z.infer<typeof cloudHistoryPayloadSchema>;
export type CloudHistoryCounts = z.infer<typeof cloudHistoryCountsSchema>;
export type CloudHistoryImportRequest = z.infer<typeof cloudHistoryImportRequestSchema>;
export type CloudHistoryImportState = z.infer<typeof cloudHistoryImportStateSchema>;
export type CloudHistoryCompleteRequest = z.infer<typeof cloudHistoryCompleteRequestSchema>;
export type CloudHistoryCancelRequest = z.infer<typeof cloudHistoryCancelRequestSchema>;
export const cloudHistoryChecksum = fileChecksum;

export function historyCounts(payload: CloudHistoryPayload): CloudHistoryCounts {
  return {
    shifts: payload.shifts.length,
    codes: payload.codes.length,
    boxes: payload.boxes.length,
    items: payload.items.length,
    pallets: payload.pallets.length,
    owners: payload.owners.length,
  };
}

/** Bounded lines, including a split UTF-8 character. Errors never include source values. */
async function* lines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let byteLength = 0;
  let lineNumber = 0;
  try {
    for await (const chunk of chunks) {
      let start = 0;
      for (let i = 0; i <= chunk.length; i++) {
        if (i < chunk.length && chunk[i] !== 10) continue;
        byteLength += i - start;
        if (byteLength > (lineNumber === 0 ? MAX_HISTORY_MANIFEST_BYTES : MAX_HISTORY_PART_BYTES))
          throw new Error("history_size");
        pending += decoder.decode(chunk.subarray(start, i), { stream: true });
        if (i < chunk.length) {
          pending += decoder.decode();
          yield pending;
          pending = "";
          byteLength = 0;
          lineNumber++;
          start = i + 1;
        }
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) yield pending;
  } catch {
    throw new Error("history_stream");
  }
}

/** First line is the manifest, subsequent lines are ordered verified parts. Consume to EOF before completing an import. */
export async function* readCloudHistoryFile(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<CloudHistoryManifest | CloudHistoryPart> {
  let manifest: CloudHistoryManifest | undefined;
  let index = 0;
  for await (const line of lines(chunks)) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("history_json");
    }
    if (manifest === undefined) {
      const parsed = cloudHistoryManifestSchema.safeParse(raw);
      if (!parsed.success) throw new Error("history_manifest");
      manifest = parsed.data;
      if ((await cloudHistoryChecksum(manifest)) !== manifest.checksum)
        throw new Error("history_checksum");
      yield manifest;
    } else {
      const parsed = cloudHistoryPartSchema.safeParse(raw);
      if (!parsed.success) throw new Error("history_part");
      const part = parsed.data;
      const expected = manifest.parts[index];
      if (
        part.index !== index ||
        expected === undefined ||
        expected.checksum !== part.checksum ||
        (await cloudHistoryChecksum(part)) !== part.checksum ||
        HISTORY_CATEGORIES.some((key) => part.payload[key].length !== expected.counts[key])
      )
        throw new Error("history_part_mismatch");
      yield part;
      index++;
    }
  }
  if (manifest === undefined || index !== manifest.parts.length)
    throw new Error("history_incomplete");
}

export function readCloudHistoryBlob(
  blob: Blob,
): AsyncGenerator<CloudHistoryManifest | CloudHistoryPart> {
  const reader = blob.stream().getReader();
  async function* chunks() {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  return readCloudHistoryFile(chunks());
}
