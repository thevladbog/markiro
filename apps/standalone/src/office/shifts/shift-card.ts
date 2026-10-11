import type { OfficeBox, OfficePallet } from "../../host/protocol.js";

/**
 * What the card of a shift (plan О-Ф) says of its boxes and pallets, from
 * the host's lists (`GET /v1/office/shifts/{id}/boxes`, `…/pallets`).
 */

/** Boxes on one page of the card. */
export const BOX_PAGE_SIZE = 50;

/** A box's or a pallet's state: taken apart wins over closed. */
export type PackState = "open" | "closed" | "disassembled";

export function packState(
  pack: Pick<OfficeBox | OfficePallet, "closedAt" | "disassembledAt">,
): PackState {
  return pack.disassembledAt !== null ? "disassembled" : pack.closedAt !== null ? "closed" : "open";
}

/**
 * The label check the station sent last: a later check overwrites an earlier
 * one on the host, so of a verified and a skipped instant the later counts.
 */
export type LabelState = "verified" | "skipped" | "none";

export function labelState(
  pack: Pick<OfficeBox | OfficePallet, "printVerifiedAt" | "printSkippedAt">,
): LabelState {
  const { printVerifiedAt: verified, printSkippedAt: skipped } = pack;
  if (verified === null && skipped === null) return "none";
  if (skipped === null) return "verified";
  if (verified === null) return "skipped";
  // Instants, not text: `…:01Z` and `…:01.500Z` are both valid and do not sort as they read.
  return Date.parse(verified) > Date.parse(skipped) ? "verified" : "skipped";
}

/**
 * A box that joined its pallet after the pallet was closed: the station
 * closed it later than the pallet it stands on. Nothing refuses it on the
 * host, so the card is where it shows (the export warns of the same boxes,
 * `late_boxes`). A box taken apart no longer stands on the pallet.
 */
export function isLateBox(
  box: Pick<OfficeBox, "closedAt" | "disassembledAt">,
  pallet: Pick<OfficePallet, "closedAt"> | undefined,
): boolean {
  if (box.closedAt === null || box.disassembledAt !== null) return false;
  if (pallet === undefined || pallet.closedAt === null) return false;
  return Date.parse(box.closedAt) > Date.parse(pallet.closedAt);
}

/**
 * Whether the boxes the station counted when it closed a pallet differ from
 * the host's own count now. A pallet taken apart is left out: its count is
 * stale by design, and the card says when it was taken apart instead.
 */
export function palletCountDiffers(
  pallet: Pick<OfficePallet, "boxCountReported" | "boxes" | "closedAt" | "disassembledAt">,
): boolean {
  return (
    packState(pallet) === "closed" &&
    pallet.boxCountReported !== null &&
    pallet.boxCountReported !== pallet.boxes
  );
}

/** The digits a filter by the SSCC's last digits keeps: anything else typed is dropped. */
export function ssccTail(typed: string): string {
  return typed.replace(/\D/g, "");
}

/**
 * Whether a box's SSCC ends with `tail` (digits only, as `ssccTail` gives
 * them): an empty tail keeps every box, a box without an SSCC only then.
 */
export function endsWithTail(sscc: string | null, tail: string): boolean {
  return tail === "" || (sscc !== null && sscc.endsWith(tail));
}

/** An SSCC as people read it, `(00)` before the 18 digits. */
export function ssccText(sscc: string): string {
  return `(00)${sscc}`;
}
