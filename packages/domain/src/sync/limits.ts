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

/**
 * Upper bound on how many PALLET closures a single `/station/scans` batch may
 * carry, shared between the API's request schema (`syncBatchSchema.pallets` in
 * `apps/api/src/modules/station-scans/dto.ts`), the station's drain loop
 * (`readClosedUnackedPallets` in `apps/station/src/lib/sync.ts`) and the
 * handheld's (`SyncEngine`).
 *
 * Every word of the reasoning above applies verbatim: if the two sides
 * disagree, the oversized payload is rejected with a 400 and — since the drain
 * treats every error as retryable and never drops data — retried forever,
 * wedging pallet closures, box closures and item delivery together on that
 * device.
 *
 * Lower than the box limit only because a pallet closes once per
 * `palletBoxCapacity` boxes: a batch that carries 50 box closures cannot
 * physically carry more than a handful of pallets.
 */
export const MAX_PALLET_CLOSURES_PER_SYNC_BATCH = 20;
