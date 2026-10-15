import { z } from "zod";

import { CODE_PLACEMENT_STATES } from "./code-search.js";
import { shiftStatusSchema } from "./protocol.js";

// Plan КРТ: mirrors `markiro_proto::pack_cards`. Lenient like the Rust
// response types (a field a newer host adds is tolerated).

export const CARD_ROW_LIMIT = 10_000;
export const PALLET_PAGE_SIZE = 100;

const instant = z.iso.datetime();
const codeHash = z.string().regex(/^[0-9a-f]{64}$/);
const sscc = z.string().regex(/^[0-9]{18}$/);

export const officePackShiftSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: shiftStatusSchema,
  productionDate: z.string(),
  productName: z.string(),
  lineName: z.string(),
});
export const officePackPalletSchema = z.object({
  id: z.string(),
  sscc: sscc.nullable(),
  closedAt: instant.nullable(),
  disassembledAt: instant.nullable(),
});
export const officeBoxItemSchema = z.object({
  scanId: z.string(),
  codeHash,
  gtin14: z.string(),
  serial: z.string(),
  addedAt: instant,
  state: z.enum(CODE_PLACEMENT_STATES),
  leftAt: instant.nullable(),
  operatorName: z.string().nullable(),
});
export const officeBoxExceptionSchema = z.object({
  id: z.string(),
  kind: z.enum(["undo", "clear", "reprint", "disassemble"]),
  codeHash: codeHash.nullable(),
  reasonCode: z.string().nullable(),
  reasonText: z.string().nullable(),
  occurredAt: instant,
  receivedAt: instant,
  deviceName: z.string(),
  operatorName: z.string().nullable(),
});
export const officePackDocumentSchema = z.object({
  id: z.string(),
  docNo: z.string(),
  appliedAt: instant,
  reasonName: z.string().nullable(),
  appliedByName: z.string().nullable(),
});
/** What a box, a pallet and a row of the list share. */
const pack = {
  id: z.string(),
  sscc: sscc.nullable(),
  deviceId: z.string(),
  deviceName: z.string(),
  openedAt: instant,
  closedAt: instant.nullable(),
  disassembledAt: instant.nullable(),
};
const count = z.number().int().nonnegative();
const labelCheck = { printVerifiedAt: instant.nullable(), printSkippedAt: instant.nullable() };
const documents = z.array(officePackDocumentSchema).default([]);

export const officeBoxCardSchema = z.object({
  ...pack,
  ...labelCheck,
  shift: officePackShiftSchema,
  operatorName: z.string().nullable(),
  units: count,
  itemCountReported: count.nullable(),
  digestMatches: z.boolean().nullable(),
  pallet: officePackPalletSchema.nullable(),
  items: z.array(officeBoxItemSchema),
  itemsCapped: z.boolean(),
  exceptions: z.array(officeBoxExceptionSchema),
  documents,
});
export const officePalletBoxSchema = z.object({
  id: z.string(),
  sscc: sscc.nullable(),
  closedAt: instant.nullable(),
  disassembledAt: instant.nullable(),
  units: count,
});
export const officePalletExceptionSchema = z.object({
  id: z.string(),
  kind: z.enum(["reprint", "disassemble"]),
  reasonCode: z.string(),
  reasonText: z.string().nullable(),
  occurredAt: instant,
  receivedAt: instant,
  deviceName: z.string(),
  operatorName: z.string().nullable(),
});
const standing = {
  boxes: count,
  units: count,
  boxCountReported: z.number().int().positive().nullable(),
  /** Boxes that stood on the pallet and were taken apart since; see `OfficePallet`. */
  disassembledBoxes: count.default(0),
};
export const officePalletCardSchema = z.object({
  ...pack,
  ...labelCheck,
  ...standing,
  shift: officePackShiftSchema,
  operatorName: z.string().nullable(),
  members: z.array(officePalletBoxSchema),
  membersCapped: z.boolean(),
  exceptions: z.array(officePalletExceptionSchema),
  documents,
});
export const officePalletRowSchema = z.object({
  ...pack,
  ...standing,
  shiftId: z.string(),
  shiftNumber: z.string(),
  productionDate: z.string(),
  productId: z.string(),
  productName: z.string(),
  lineId: z.string(),
  lineName: z.string(),
});
export const officePalletPageSchema = z.object({
  items: z.array(officePalletRowSchema),
  nextCursor: z.string().nullable(),
  stations: z.array(z.object({ id: z.string(), name: z.string(), revoked: z.boolean() })),
});
export type OfficeBoxCard = z.infer<typeof officeBoxCardSchema>;
export type OfficeBoxItem = z.infer<typeof officeBoxItemSchema>;
export type OfficeBoxException = z.infer<typeof officeBoxExceptionSchema>;
export type OfficePalletCard = z.infer<typeof officePalletCardSchema>;
export type OfficePalletBox = z.infer<typeof officePalletBoxSchema>;
export type OfficePalletException = z.infer<typeof officePalletExceptionSchema>;
export type OfficePalletRow = z.infer<typeof officePalletRowSchema>;
export type OfficePalletPage = z.infer<typeof officePalletPageSchema>;
export type OfficePackDocument = z.infer<typeof officePackDocumentSchema>;

/** What `GET /v1/office/pallets` asks; every value is the shell's plain URL characters. */
export interface PalletListQuery {
  product?: string;
  line?: string;
  device?: string;
  fromMs?: number;
  toMs?: number;
  sscc?: string;
}

const PALLET_PARAMS = ["product", "line", "device", "fromMs", "toMs", "sscc"] as const;

/**
 * The path of one page of the list: the parameters in a fixed order (one
 * cache key per query), the cursor last. A value the shell's path check
 * would refuse is refused here first.
 */
export function palletListPath(query: PalletListQuery, cursor: string | null): string {
  const parts: string[] = [];
  for (const name of PALLET_PARAMS) {
    const value = query[name];
    if (value === undefined) continue;
    const text = String(value);
    if (!/^[0-9a-z-]+$/.test(text)) throw new RangeError(`not a list value: ${name}`);
    parts.push(`${name}=${text}`);
  }
  if (cursor !== null) {
    if (!/^(o|[0-9]{1,15})~[0-9a-f-]{36}$/.test(cursor)) throw new RangeError("not a cursor");
    parts.push(`cursor=${cursor}`);
  }
  return parts.length === 0 ? "/v1/office/pallets" : `/v1/office/pallets?${parts.join("&")}`;
}

/** A box's or a pallet's id as the host writes it: a lower-case hyphenated UUID. */
export function isPackId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}
