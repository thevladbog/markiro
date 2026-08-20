/**
 * Normalizes a `to` filter's upper bound for date-range queries. Admin UIs
 * send date-only strings (`YYYY-MM-DD`); zod's `z.coerce.date()` parses that
 * as UTC MIDNIGHT of that day, so a plain `lte(column, to)` silently
 * excludes every row scanned/created later that same day -- exactly the day
 * the caller meant to include.
 *
 * `isDateOnly` detects that shape (all UTC time-of-day fields at zero); for
 * those, `toExclusiveEnd` returns the START OF THE NEXT DAY so the caller
 * can switch to an exclusive `lt` comparison, which is inclusive of the
 * whole named day. A `to` that already carries a real time-of-day keeps
 * using `lte` unchanged -- see call sites (`code-search.service.ts`,
 * `disaggregation.service.ts`).
 */
export function isDateOnly(to: Date): boolean {
  return (
    to.getUTCHours() === 0 &&
    to.getUTCMinutes() === 0 &&
    to.getUTCSeconds() === 0 &&
    to.getUTCMilliseconds() === 0
  );
}

export function toExclusiveEnd(to: Date): Date {
  const next = new Date(to);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
