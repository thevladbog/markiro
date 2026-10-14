import {
  CONFLICT_MAX_PAGE,
  type ConflictQuery,
  type OfficeConflictScan,
} from "../../host/review.js";

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
 * Where the loser's box is shown. Until plan КРТ gives a box its card, the
 * box's shift's card, its boxes filtered by the SSCC (`?box=`); a box still
 * open or no box at all (a validation shift) opens the shift's card only.
 */
export function loserBoxLink(scan: OfficeConflictScan): string {
  return scan.boxSscc === null
    ? `/shifts/${scan.shiftId}`
    : `/shifts/${scan.shiftId}?box=${scan.boxSscc}`;
}
