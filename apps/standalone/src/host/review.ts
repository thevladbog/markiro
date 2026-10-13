import { z } from "zod";

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

export const officeShiftExceptionSchema = z.object({
  id: z.string(),
  subject: z.enum(["box", "pallet"]),
  kind: z.enum(["undo", "clear", "reprint", "disassemble"]),
  subjectId: z.string(),
  sscc: z.string().nullable(),
  serial: z.string().nullable(),
  reasonCode: z.string().nullable(),
  reasonText: z.string().nullable(),
  deviceId: z.string(),
  deviceName: z.string(),
  operatorName: z.string().nullable(),
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
