import {
  CONFLICT_MAX_PAGE,
  type ConflictQuery,
  type OfficeConflict,
  type OfficeConflictScan,
} from "../../host/review.js";
import { shiftCardPath } from "../shifts/shift-card.js";

/** The «Состояние» filter of «Конфликты», unreviewed first (the cloud's default). */
export const REVIEWED_FILTERS = ["unreviewed", "reviewed", "all"] as const;
export type ReviewedFilter = (typeof REVIEWED_FILTERS)[number];

/** The filter a link or the address names; the unreviewed ones otherwise. */
export function readReviewed(text: string | null): ReviewedFilter {
  return text === "reviewed" || text === "all" ? text : "unreviewed";
}

/** A page the address names: a whole number the list reaches (`CONFLICT_MAX_PAGE`), the first otherwise. */
export function readPage(text: string | null): number {
  if (text === null || !/^\d+$/.test(text)) return 1;
  const page = Number(text);
  return Number.isSafeInteger(page) && page >= 1 && page <= CONFLICT_MAX_PAGE ? page : 1;
}

/** What the host is asked: only what is narrowed. */
export function conflictQuery(
  shiftId: string,
  reviewed: ReviewedFilter,
  page: number,
): ConflictQuery {
  return {
    ...(shiftId === "" ? {} : { shiftId }),
    ...(reviewed === "all" ? {} : { reviewed: reviewed === "reviewed" }),
    page,
  };
}

/**
 * Where the loser's box is shown: its card (plan КРТ). A scan that went into
 * no box (a validation shift's, plan РЕЖ) opens its shift's card instead; the
 * page itself offers no «box» link for it.
 */
export function loserBoxLink(scan: OfficeConflictScan): string {
  return scan.boxId === null ? shiftCardPath(scan.shiftId) : `/codes/box/${scan.boxId}`;
}

/**
 * The translation key of what happened to the loser. A displacement says the
 * code left the loser's box; a validation shift's scan (plan РЕЖ) had none.
 */
export function conflictKindKey(conflict: OfficeConflict): string {
  return conflict.kind === "displaced" && conflict.loser.boxId === null
    ? "office.conflicts.kinds.displacedUnboxed"
    : `office.conflicts.kinds.${conflict.kind}`;
}
