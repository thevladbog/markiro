import { z } from "zod";

import { exportFileSchema } from "./export-files.js";
import { codeOwnerSchema } from "./protocol.js";

// The office's review of production (plan КНФ): mirrors `markiro_proto::review`.
// Answers are lenient like the Rust response types (a field a newer host adds is
// tolerated); `proto/fixtures/office-*.json` hold the shapes both sides read.

/** The rows of one page (`CONFLICT_PAGE_SIZE`), the last page (`CONFLICT_MAX_PAGE`). */
export const CONFLICT_PAGE_SIZE = 50;
export const CONFLICT_MAX_PAGE = 200;
/** The most rows a shift's exceptions or refusals list (`SHIFT_REVIEW_LIMIT`). */
export const SHIFT_REVIEW_LIMIT = 500;

export const CONFLICT_KINDS = ["late", "displaced"] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

const instant = z.iso.datetime();
const codeHash = z.string().regex(/^[0-9a-f]{64}$/);

export const officeConflictScanSchema = z.object({
  shiftId: z.string(),
  shiftNumber: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  operatorName: z.string().nullable(),
  scannedAt: instant,
  boxId: z.string().nullable(),
  boxSscc: z.string().nullable(),
  /** The scan's shift is closed: only a closed shift's box is taken apart (plan ДЗГ-О). */
  shiftClosed: z.boolean(),
  /** The scan's box was taken apart, by a station or a document. */
  boxDisassembled: z.boolean(),
});
export type OfficeConflictScan = z.infer<typeof officeConflictScanSchema>;

export const officeConflictSchema = z.object({
  id: z.string(),
  kind: z.enum(CONFLICT_KINDS),
  codeHash,
  gtin14: z.string(),
  serial: z.string(),
  loser: officeConflictScanSchema,
  winner: officeConflictScanSchema,
  detectedAt: instant,
  reviewedAt: instant.nullable(),
  reviewedByName: z.string().nullable(),
});
export type OfficeConflict = z.infer<typeof officeConflictSchema>;

export const officeConflictPageSchema = z.object({
  items: z.array(officeConflictSchema),
  page: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});
export type OfficeConflictPage = z.infer<typeof officeConflictPageSchema>;

/**
 * One exception of a shift's boxes or pallets. `source: "office"` is a box or
 * pallet an applied disaggregation document took apart (plan ДЗГ-О): it names
 * the document and the office user and has no station or operator, and the
 * document's reason is `reasonText`.
 */
export const officeShiftExceptionSchema = z.object({
  id: z.string(),
  source: z.enum(["station", "office"]),
  subject: z.enum(["box", "pallet"]),
  kind: z.enum(["undo", "clear", "reprint", "disassemble"]),
  subjectId: z.string(),
  sscc: z.string().nullable(),
  serial: z.string().nullable(),
  reasonCode: z.string().nullable(),
  reasonText: z.string().nullable(),
  deviceId: z.string().nullable(),
  deviceName: z.string().nullable(),
  operatorName: z.string().nullable(),
  documentId: z.string().nullable(),
  documentNo: z.string().nullable(),
  officeUserName: z.string().nullable(),
  occurredAt: instant,
  receivedAt: instant,
});
export type OfficeShiftException = z.infer<typeof officeShiftExceptionSchema>;

export const officeShiftExceptionsSchema = z.object({
  items: z.array(officeShiftExceptionSchema),
  total: z.number().int().nonnegative(),
});
export type OfficeShiftExceptions = z.infer<typeof officeShiftExceptionsSchema>;

/** A refused record: its kind as text, so a kind a newer host adds does not fail the list. */
export const officeShiftRejectionSchema = z.object({
  recordId: z.string(),
  kind: z.string().nullable(),
  code: z.string(),
  details: z.record(z.string(), z.unknown()).nullable(),
  deviceId: z.string(),
  deviceName: z.string(),
  receivedAt: instant,
});
export type OfficeShiftRejection = z.infer<typeof officeShiftRejectionSchema>;

export const officeShiftRejectionsSchema = z.object({
  items: z.array(officeShiftRejectionSchema),
  total: z.number().int().nonnegative(),
});
export type OfficeShiftRejections = z.infer<typeof officeShiftRejectionsSchema>;

/** The rows of one page of a shift's scan history (`SCAN_HISTORY_PAGE_SIZE`), the most a page may ask. */
export const SCAN_HISTORY_PAGE_SIZE = 50;
export const SCAN_HISTORY_MAX_PAGE_SIZE = 100;

/**
 * What the journal says of a scan of the work screen: `ok` — accepted; `duplicate` — the code
 * was scanned before; `wrong_gtin` — another product's code; `invalid` — not a readable code.
 */
export const SCAN_VERDICTS = ["ok", "duplicate", "wrong_gtin", "invalid"] as const;
export type ScanVerdict = (typeof SCAN_VERDICTS)[number];

/**
 * One scan of a shift's history (`GET /v1/office/shifts/{id}/scans`), mirroring
 * `markiro_proto::review::OfficeScanHistoryItem`. The code never arrives whole: only its GTIN
 * and at most the last four characters of its serial.
 */
export const officeScanHistoryItemSchema = z.object({
  id: z.string(),
  scannedAt: instant,
  receivedAt: instant,
  deviceId: z.string(),
  deviceName: z.string(),
  operatorName: z.string().nullable(),
  verdict: z.enum(SCAN_VERDICTS),
  /** `local`: the station's own journal knew the code; `host`: the host's. */
  duplicateSource: z.string().nullable(),
  gtin14: z.string().nullable(),
  serialTail: z.string().max(4).nullable(),
  boxId: z.string().nullable(),
  boxSscc: z.string().nullable(),
  palletId: z.string().nullable(),
  palletSscc: z.string().nullable(),
});
export type OfficeScanHistoryItem = z.infer<typeof officeScanHistoryItemSchema>;

export const officeScanHistoryPageSchema = z.object({
  items: z.array(officeScanHistoryItemSchema),
  /** Opaque: sent back as `cursor` for the next page; `null` on the last. */
  nextCursor: z.string().nullable(),
});
export type OfficeScanHistoryPage = z.infer<typeof officeScanHistoryPageSchema>;

/** What `GET /v1/office/shifts/{id}/scans` narrows to; every field is optional. */
export interface ScanHistoryQuery {
  result?: ScanVerdict;
  /** A station's id. */
  device?: string;
  /** A box's id. */
  box?: string;
  /** The device's instants in milliseconds since 1970: `fromMs` inclusive, `toMs` exclusive. */
  fromMs?: number;
  toMs?: number;
  /** The last characters of the serial (1–32 letters, digits and `-_.~`). */
  q?: string;
}

const SCAN_PARAMS = ["result", "device", "box", "fromMs", "toMs", "q"] as const;

/** A serial tail the shell lets through to the host: plain URL characters only. */
export const SCAN_TAIL_PATTERN = /^[0-9A-Za-z._~-]{1,32}$/;

/**
 * The path of one page of a shift's scans: the filters in a fixed order (one cache key per
 * query), then the limit and the cursor. The shell lets only plain URL characters through, so
 * a value outside them is refused here first.
 */
export function shiftScansPath(
  shiftId: string,
  query: ScanHistoryQuery,
  cursor: string | null,
  limit?: number,
): string {
  const parts: string[] = [];
  for (const name of SCAN_PARAMS) {
    const value = query[name];
    if (value === undefined) continue;
    const text = String(value);
    const fits = name === "q" ? SCAN_TAIL_PATTERN.test(text) : /^[0-9a-z_-]+$/.test(text);
    if (!fits) throw new RangeError(`not a list value: ${name}`);
    parts.push(`${name}=${text}`);
  }
  if (limit !== undefined) parts.push(`limit=${limit}`);
  if (cursor !== null) {
    if (!/^[0-9]{1,15}~[0-9a-f-]{36}$/.test(cursor)) throw new RangeError("not a cursor");
    parts.push(`cursor=${cursor}`);
  }
  const base = `/v1/office/shifts/${shiftId}/scans`;
  return parts.length === 0 ? base : `${base}?${parts.join("&")}`;
}

/**
 * Mirrors `markiro_proto::review::OfficeShiftExports`: `GET /v1/office/shifts/{id}/exports`,
 * the exports of the shift the office saved (the audit trail's `shift.export` rows), newest first.
 */
export const officeShiftExportSchema = z.object({
  id: z.number().int(),
  recordedAt: z.string(),
  userName: z.string().nullable(),
  formatId: z.string(),
  formatVersion: z.number().int(),
  maxLines: z.number().int().nullable(),
  palletId: z.string().nullable(),
  documentId: z.string(),
  partCount: z.number().int(),
  codeCount: z.number().int(),
  boxCount: z.number().int(),
  palletCount: z.number().int(),
  openPalletSuppressedBoxCount: z.number().int(),
  /** The files the export stored on the host (migration `0029`), by part; none before they were stored. */
  files: z.array(exportFileSchema),
});
export type OfficeShiftExport = z.infer<typeof officeShiftExportSchema>;

export const officeShiftExportsSchema = z.object({ items: z.array(officeShiftExportSchema) });
export type OfficeShiftExports = z.infer<typeof officeShiftExportsSchema>;

/** What `GET /v1/office/conflicts` narrows to; the first page when `page` is left out. */
export interface ConflictQuery {
  /** The losing shift's id. */
  shiftId?: string;
  reviewed?: boolean;
  page?: number;
}

export function conflictsPath(query: ConflictQuery): string {
  const params = new URLSearchParams();
  if (query.shiftId !== undefined) params.set("shift", query.shiftId);
  if (query.reviewed !== undefined) params.set("reviewed", String(query.reviewed));
  if (query.page !== undefined && query.page !== 1) params.set("page", String(query.page));
  const text = params.toString();
  return text === "" ? "/v1/office/conflicts" : `/v1/office/conflicts?${text}`;
}

/** The most records one status request names (`MAX_CONFLICT_STATUS_RECORDS`). */
export const MAX_CONFLICT_STATUS_RECORDS = 200;

/**
 * `POST /v1/device/conflicts/status` (plan КНФ): the station's records whose
 * conflict or displacement nobody resolved yet; strict, like every request.
 */
export const conflictStatusRequestSchema = z.strictObject({
  recordIds: z.array(z.uuid()).min(1).max(MAX_CONFLICT_STATUS_RECORDS),
});
export type ConflictStatusRequest = z.infer<typeof conflictStatusRequestSchema>;

/** Of the asked records, those the office reviewed, with the host's instant. */
export const conflictStatusResponseSchema = z.object({
  reviewed: z.array(z.object({ recordId: z.string(), reviewedAt: instant })),
});
export type ConflictStatusResponse = z.infer<typeof conflictStatusResponseSchema>;

/** A scan of this station an earlier scan elsewhere took the code from. */
export const deviceDisplacementSchema = z.object({
  conflictId: z.uuid(),
  recordId: z.string(),
  shiftId: z.string(),
  /** The losing shift's number: the station keeps it with the row. */
  shiftNumber: z.string(),
  codeHash,
  boxId: z.string().nullable(),
  /** The box's SSCC on the host, `null` while the host has it open. */
  boxSscc: z.string().nullable(),
  detectedAt: instant,
  winner: codeOwnerSchema,
  reviewedAt: instant.nullable(),
});
export type DeviceDisplacement = z.infer<typeof deviceDisplacementSchema>;

/** One page of the station's displacements, oldest first after its cursor. */
export const deviceDisplacementsSchema = z.object({
  items: z.array(deviceDisplacementSchema),
  more: z.boolean(),
});
export type DeviceDisplacements = z.infer<typeof deviceDisplacementsSchema>;

/** `GET /v1/device/displacements` after the cursor a station holds (both ends, or none). */
export function displacementsPath(after: { at: string; id: string } | null): string {
  return after === null
    ? "/v1/device/displacements"
    : `/v1/device/displacements?afterAt=${encodeURIComponent(after.at)}&afterId=${encodeURIComponent(after.id)}`;
}
