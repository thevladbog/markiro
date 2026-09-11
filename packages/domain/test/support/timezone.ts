/**
 * Timezone control for tests that assert a LOCAL calendar date.
 *
 * The same helper the station carries in `apps/station/test/support/timezone.ts`,
 * needed here now that `boxLabelFields` and its fixtures live in the domain.
 * Any local-date assertion is otherwise a coin flip: this repo's developers sit
 * in a Moscow-ish zone and CI runs in UTC, so an unpinned test passes in one and
 * fails in the other. Node re-reads `process.env.TZ` for every `Date` operation
 * performed AFTER the assignment, because the `process.env` setter invalidates
 * V8's timezone cache.
 */

function restore(previous: string | undefined): void {
  if (previous === undefined) delete process.env.TZ;
  else process.env.TZ = previous;
}

/** Pins the timezone for one synchronous call — for pure-function assertions. */
export function withTimeZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return run();
  } finally {
    restore(previous);
  }
}
