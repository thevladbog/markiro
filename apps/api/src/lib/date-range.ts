import type { AnyColumn, SQL } from "drizzle-orm";
import { lt, lte } from "drizzle-orm";

/**
 * Normalizes a `to` filter's upper bound for date-range queries. Admin UIs
 * send date-only strings (`YYYY-MM-DD`); a plain `lte(column, to)` on the
 * coerced midnight-UTC `Date` would silently exclude every row
 * scanned/created later that same day -- exactly the day the caller meant to
 * include. An explicit timestamp (e.g. `2026-08-20T00:00:00.000Z`) that
 * happens to land on midnight must NOT get this treatment, so the date-only
 * shape can't be detected from the coerced `Date` alone -- it has to come
 * from the RAW query-string value (see `listCodesQuerySchema` /
 * `listDocumentsQuerySchema`, which transform the raw `to` string into this
 * `{ date, dateOnly }` shape).
 *
 * `dateOnly: true` switches to an exclusive `lt` against the START OF THE
 * NEXT DAY, which is inclusive of the whole named day. `dateOnly: false`
 * (a real timestamp) keeps `lte` unchanged.
 */
export interface DateBound {
  date: Date;
  dateOnly: boolean;
}

export function toExclusiveEnd(date: Date): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Builds the upper-bound condition for a `to` filter, or `undefined` if none was supplied. */
export function upperBoundCondition(column: AnyColumn, to: DateBound | undefined): SQL | undefined {
  if (!to) return undefined;
  return to.dateOnly ? lt(column, toExclusiveEnd(to.date)) : lte(column, to.date);
}
