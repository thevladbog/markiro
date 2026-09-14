/** Persist the original server/boot-relative monotonic anchor across process restarts. */
export interface TrustedClock {
  serverMs: number;
  monotonicMs: number;
  bootId: string;
  highWaterMs: number;
  wallHighWaterMs: number;
}

/** Persist returned now and sample.wallMs as their high-water marks in one productive commit. */
export function assessClock(
  anchor: TrustedClock,
  sample: { monotonicMs: number; bootId: string; wallMs: number },
): { trusted: true; now: number } | { trusted: false; reason: "clock_untrusted" } {
  const untrusted = { trusted: false, reason: "clock_untrusted" } as const;
  if (
    ![
      anchor.serverMs,
      anchor.monotonicMs,
      anchor.highWaterMs,
      anchor.wallHighWaterMs,
      sample.monotonicMs,
      sample.wallMs,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !anchor.bootId ||
    sample.bootId !== anchor.bootId ||
    anchor.highWaterMs < anchor.serverMs ||
    sample.monotonicMs < anchor.monotonicMs ||
    sample.wallMs < anchor.wallHighWaterMs
  )
    return untrusted;
  const elapsed = sample.monotonicMs - anchor.monotonicMs;
  if (elapsed > Number.MAX_SAFE_INTEGER - anchor.serverMs) return untrusted;
  const now = anchor.serverMs + elapsed;
  // Clamping a regressed monotonic reading would freeze time and extend grants.
  if (now < anchor.highWaterMs) return untrusted;
  return { trusted: true, now };
}
