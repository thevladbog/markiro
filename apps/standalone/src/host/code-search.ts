import { z } from "zod";

import { SCAN_VERDICTS, shiftStatusSchema } from "./protocol.js";

// Code search in the office (the owner's beta feedback «Поиск кодов»):
// mirrors `markiro_proto::code_search`. The host's answers are lenient like
// the Rust response types (a field a newer host adds is tolerated);
// `proto/fixtures/office-code-*.json` hold the shapes both sides read.

/** The rows of one page (`CODE_PAGE_SIZE`) and the most a search counts (`CODE_SEARCH_CAP`). */
export const CODE_PAGE_SIZE = 50;
export const CODE_SEARCH_CAP = 10_000;
/** The last page a search reaches (`office_codes::MAX_PAGE`). */
export const CODE_MAX_PAGE = CODE_SEARCH_CAP / CODE_PAGE_SIZE;

/** Where a placement stands now (`markiro_proto::code_search::CodePlacementState`). */
export const CODE_PLACEMENT_STATES = ["open_box", "packed", "removed", "displaced"] as const;
export type CodePlacementState = (typeof CODE_PLACEMENT_STATES)[number];

const instant = z.iso.datetime();
const codeHash = z.string().regex(/^[0-9a-f]{64}$/);

/** One placement of a code in a box (`OfficeCodeItem`). */
export const officeCodeItemSchema = z.object({
  scanId: z.string(),
  codeHash,
  gtin14: z.string(),
  serial: z.string(),
  scannedAt: instant,
  state: z.enum(CODE_PLACEMENT_STATES),
  leftAt: instant.nullable(),
  boxId: z.string(),
  boxSscc: z.string().nullable(),
  boxClosedAt: instant.nullable(),
  boxDisassembledAt: instant.nullable(),
  palletId: z.string().nullable(),
  palletSscc: z.string().nullable(),
  palletDisassembledAt: instant.nullable(),
  shiftId: z.string(),
  shiftNumber: z.string(),
  shiftStatus: shiftStatusSchema,
  productionDate: z.string(),
  productName: z.string(),
  lineName: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  operatorName: z.string().nullable(),
});
export type OfficeCodeItem = z.infer<typeof officeCodeItemSchema>;

/** One page of a search, newest scan first (`OfficeCodePage`). */
export const officeCodePageSchema = z.object({
  items: z.array(officeCodeItemSchema),
  page: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  capped: z.boolean(),
});
export type OfficeCodePage = z.infer<typeof officeCodePageSchema>;

/** One event of a code's history (`OfficeCodeEvent`), oldest first. */
export const officeCodeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("scan"),
    at: instant,
    scanId: z.string(),
    verdict: z.enum(SCAN_VERDICTS),
    duplicateSource: z.enum(["local", "host"]).nullable(),
    shiftId: z.string(),
    shiftNumber: z.string(),
    deviceName: z.string(),
    operatorName: z.string().nullable(),
    boxId: z.string().nullable(),
    placed: z.boolean(),
  }),
  z.object({
    type: z.literal("removed"),
    at: instant,
    boxId: z.string(),
    boxSscc: z.string().nullable(),
    exception: z.enum(["undo", "clear", "reprint", "disassemble"]).nullable(),
    reasonCode: z.string().nullable(),
    reasonText: z.string().nullable(),
    operatorName: z.string().nullable(),
  }),
  z.object({
    type: z.literal("displaced"),
    at: instant,
    boxId: z.string(),
    boxSscc: z.string().nullable(),
  }),
  z.object({
    type: z.literal("reprint"),
    at: instant,
    outcome: z.string(),
    reasonCode: z.string(),
    deviceName: z.string(),
    operatorName: z.string().nullable(),
  }),
]);
export type OfficeCodeEvent = z.infer<typeof officeCodeEventSchema>;

/** A code's card (`OfficeCodeCard`). */
export const officeCodeCardSchema = z.object({
  codeHash,
  gtin14: z.string(),
  serial: z.string(),
  canonical: z.string(),
  ownerScanId: z.string().nullable(),
  placements: z.array(officeCodeItemSchema),
  events: z.array(officeCodeEventSchema),
});
export type OfficeCodeCard = z.infer<typeof officeCodeCardSchema>;

/**
 * What `GET /v1/office/codes` asks: at least one criterion, each in the
 * form the host takes (`office_codes::criteria`). A period's ends are
 * milliseconds since the epoch, `[fromMs, toMs)`.
 */
export interface CodeSearchQuery {
  codeHash?: string;
  gtin?: string;
  sscc?: string;
  shift?: string;
  fromMs?: number;
  toMs?: number;
  page?: number;
}

/** The order the parameters are written in: a fixed one keeps the cache key and the path alike. */
const PARAMS = ["codeHash", "gtin", "sscc", "shift", "fromMs", "toMs", "page"] as const;

/**
 * The query string of a search. Every value is digits, hex, upper-case
 * letters, `-` and `/` (a shift number's `/S`), which the shell's path
 * check passes as they are; anything else would be refused there, so it is
 * refused here first.
 */
export function codeSearchPath(query: CodeSearchQuery): string {
  const parts: string[] = [];
  for (const name of PARAMS) {
    const value = query[name];
    if (value === undefined) continue;
    const text = String(value);
    if (!/^[0-9A-Za-z/-]+$/.test(text)) {
      throw new RangeError(`not a search value: ${name}`);
    }
    parts.push(`${name}=${text}`);
  }
  return `/v1/office/codes?${parts.join("&")}`;
}
