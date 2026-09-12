/**
 * The shared sync batch bounds the handheld's Kotlin `SyncEngine` hand-copies
 * as literals (`MAX_BOX_CLOSURES`, `MAX_PALLET_CLOSURES`,
 * `MAX_SYNC_BATCH_ID_CHARS`) because Kotlin cannot import a TypeScript
 * constant. Exported to
 * `apps/handheld/app/src/test/resources/sync-limits-fixtures.json` by
 * `pnpm --filter @markiro/domain fixtures:sync-limits`;
 * `test/sync-limits-fixtures.test.ts` fails when the committed JSON drifts
 * from this module, and the handheld's `SyncLimitsFixturesTest` fails when
 * the Kotlin literals drift from the committed JSON. That closes the loop
 * `MAX_PALLET_CLOSURES`'s own doc comment flagged as missing: a device that
 * reads more closed-unacked rows than the API accepts has its whole batch
 * rejected every retry, wedging every channel on that device forever.
 */
import {
  MAX_BOX_CLOSURES_PER_SYNC_BATCH,
  MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
  MAX_SYNC_BATCH_ID_CHARS,
} from "./limits.js";

export interface SyncLimitsFixtures {
  maxBoxClosuresPerSyncBatch: number;
  maxPalletClosuresPerSyncBatch: number;
  maxSyncBatchIdChars: number;
}

export function buildSyncLimitsFixtures(): SyncLimitsFixtures {
  return {
    maxBoxClosuresPerSyncBatch: MAX_BOX_CLOSURES_PER_SYNC_BATCH,
    maxPalletClosuresPerSyncBatch: MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
    maxSyncBatchIdChars: MAX_SYNC_BATCH_ID_CHARS,
  };
}
