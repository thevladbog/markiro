/**
 * Frozen from apps/kiosk/src/sync/worker.ts at d8c6fc8b, before Task 8 taught
 * the client to inspect exact subscription error codes. That client only knew
 * the HTTP status allowlist below, so a server rolling upgrade must translate
 * a permanent subscription refusal into one of these statuses when the kiosk
 * sends no recovery capability.
 */
const PRE_TASK8_TERMINAL_STATUSES: ReadonlySet<number> = new Set([400, 409, 422]);

export function preTask8KioskWillQuarantine(status: number): boolean {
  return PRE_TASK8_TERMINAL_STATUSES.has(status);
}
