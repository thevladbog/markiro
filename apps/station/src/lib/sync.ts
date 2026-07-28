import type { StationClient } from "./api-client.js";
import type { SqlExecutor } from "./mirror.js";
import { ackThrough, outboxDepth, readBatch, type OutboxItem } from "./outbox.js";

/** Scans per request. Small enough to survive a flaky link and to retry cheaply. */
export const BATCH_SIZE = 200;
/** How long a non-empty queue may stop moving before the operator is warned. */
export const STUCK_AFTER_MS = 15 * 60 * 1000;
const BACKOFF_START_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;

export interface SyncState {
  pending: number;
  lastSuccessAt: number | null;
  /** The queue has work and has stopped moving — "the pipe is broken". */
  stuck: boolean;
}

export interface SyncEngineDeps {
  exec: SqlExecutor;
  client: Pick<StationClient, "post">;
  /** Always present in the station config; makes the batch id unique per device. */
  machineId: string;
  now?: () => number;
  onState(state: SyncState): void;
}

export interface SyncEngine {
  /** Ask for a drain. Safe to call from anywhere, any number of times. */
  nudge(): void;
  stop(): void;
  /** Resolves when no drain is in flight (tests await this instead of sleeping). */
  idle(): Promise<void>;
}

interface BatchResponse {
  applied: number;
  alreadyApplied: boolean;
}

function toPayload(items: OutboxItem[]) {
  return items.map((i) => ({
    shiftId: i.shiftId,
    terminalId: i.terminalId,
    raw: i.raw,
    verdict: i.verdict,
    scannedAt: i.scannedAt,
    code: i.code,
  }));
}

/**
 * Drains the device outbox to the server, one batch at a time.
 *
 * Delivery is at-least-once: a batch is acknowledged locally only after the
 * server confirms it, so a lost response resends. That is safe because the
 * batch id is deterministic — `<machineId>:<highest id in the batch>` — and
 * the server records it, so the resend is a no-op there. A random id per
 * attempt would silently turn every lost response into duplicated data.
 *
 * Exactly one drain runs at a time; `draining` is set synchronously before
 * the first await, the same discipline `createScanQueue` uses, because two
 * drains would read overlapping batches and race their acknowledgements.
 */
export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const now = deps.now ?? (() => Date.now());
  let draining = false;
  let stopped = false;
  let requested = false;
  let lastSuccessAt: number | null = null;
  // First `now()` at which the queue was observed non-empty with no success
  // yet to measure from. Cleared whenever the queue empties, so a later
  // backlog starts its own grace period rather than inheriting a stale one.
  let unsyncedSince: number | null = null;
  let backoffMs = BACKOFF_START_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let idleResolvers: (() => void)[] = [];

  function settleIdle() {
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  async function publishState(): Promise<void> {
    const pending = await outboxDepth(deps.exec);
    // Nothing queued is never "stuck", however long the link has been down.
    let stuck = false;
    if (pending > 0) {
      // On a device that has never synced there is no last-success time to
      // measure from, so the grace period starts the first time this engine
      // notices the backlog — otherwise a station that never once synced
      // would report stuck immediately.
      if (lastSuccessAt === null && unsyncedSince === null) unsyncedSince = now();
      const since = lastSuccessAt ?? unsyncedSince!;
      stuck = now() - since >= STUCK_AFTER_MS;
    } else {
      unsyncedSince = null;
    }
    deps.onState({ pending, lastSuccessAt, stuck });
  }

  async function drain(): Promise<void> {
    if (draining || stopped) return;
    draining = true;
    try {
      for (;;) {
        if (stopped) break;
        const batch = await readBatch(deps.exec, BATCH_SIZE);
        if (batch.length === 0) break;

        const maxId = batch[batch.length - 1]!.id;
        try {
          const res = await deps.client.post<BatchResponse>("/station/scans", {
            batchId: `${deps.machineId}:${maxId}`,
            items: toPayload(batch),
          });
          // `alreadyApplied` is a success: this exact batch is on the server
          // already, so holding on to it would wedge the queue forever.
          void res;
          await ackThrough(deps.exec, maxId);
          lastSuccessAt = now();
          backoffMs = BACKOFF_START_MS;
        } catch (err) {
          console.error("station: sync batch failed", err);
          scheduleRetry();
          break;
        }
      }
      await publishState();
    } finally {
      draining = false;
      settleIdle();
      if (requested && !stopped) {
        requested = false;
        void drain();
      }
    }
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer !== null) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drain();
    }, delay);
  }

  return {
    nudge() {
      if (stopped) return;
      if (draining) requested = true;
      else void drain();
    },
    stop() {
      stopped = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
    idle() {
      if (!draining) return Promise.resolve();
      return new Promise<void>((resolve) => idleResolvers.push(resolve));
    },
  };
}
