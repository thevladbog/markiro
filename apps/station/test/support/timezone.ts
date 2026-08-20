import { onTestFinished } from "vitest";

/**
 * Timezone control for tests that assert a LOCAL calendar date.
 *
 * Any such assertion is otherwise a coin flip: this repo's developers sit in
 * a Moscow-ish zone and CI runs in UTC, so an unpinned test passes in one and
 * fails in the other. Node re-reads `process.env.TZ` for every `Date`
 * operation performed AFTER the assignment (the `process.env` setter
 * invalidates V8's timezone cache), so setting it around a test genuinely
 * changes what "local" means — `box-label.test.ts` carries a guard test that
 * fails loudly if that ever stops holding.
 */

function restore(previous: string | undefined): void {
  if (previous === undefined) delete process.env.TZ;
  else process.env.TZ = previous;
}

/** Pins the timezone for the rest of the current test, restoring afterwards. */
export function useTimeZone(tz: string): void {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  onTestFinished(() => restore(previous));
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
