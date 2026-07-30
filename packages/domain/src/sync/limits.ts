/**
 * Upper bound on how many box closures a single `/station/scans` batch may
 * carry, shared between the API's request schema (`syncBatchSchema.boxes` in
 * `apps/api/src/modules/station-scans/dto.ts`) and the station's own drain
 * loop (`readClosedUnackedBoxes` in `apps/station/src/lib/sync.ts`).
 *
 * The two sides MUST agree: a device that reads more closed-unacked boxes
 * than the API accepts in one batch would have its whole batch rejected with
 * a 400 (Zod's `.max()`), and — since the drain treats every error as
 * retryable and never drops data (see sync.ts's module doc comment) — the
 * identical oversized payload would be retried forever, permanently wedging
 * both box closures and item delivery on that device. Keeping this in one
 * place (rather than two independently-chosen numbers that happen to match
 * today) is what makes that impossible to reintroduce by editing only one
 * side.
 */
export const MAX_BOX_CLOSURES_PER_SYNC_BATCH = 50;
