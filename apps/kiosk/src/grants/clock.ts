import { assessClock, type TrustedClock } from "@markiro/domain";

/** performance.now belongs only to this JS process. Reload never renews an offline horizon. */
const processId = crypto.randomUUID();
export interface ClockSample {
  monotonicMs: number;
  bootId: string;
  wallMs: number;
}
export function clockSample(): ClockSample {
  return { monotonicMs: Math.floor(performance.now()), bootId: processId, wallMs: Date.now() };
}
export function trustedNow(clock: TrustedClock | null, sample: ClockSample): number | null {
  if (!clock) return null;
  const result = assessClock(clock, sample);
  return result.trusted ? result.now : null;
}
