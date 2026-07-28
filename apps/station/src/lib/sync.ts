import type { StationClient } from "./api-client.js";
import { getInstallId } from "./install-id.js";
import type { SqlExecutor } from "./mirror.js";
import { ackThrough, oldestQueuedAt, outboxDepth, readBatch, type OutboxItem } from "./outbox.js";

/** Scans per request. Small enough to survive a flaky link and to retry cheaply. */
export const BATCH_SIZE = 200;
/** How long a non-empty queue may stop moving before the operator is warned. */
export const STUCK_AFTER_MS = 15 * 60 * 1000;
/**
 * Exported so tests that deliberately fail a batch can wait out the
 * engine's own scheduled retry (rather than guessing a delay) before
 * exercising something that depends on no retry being pending — e.g. proving
 * a `nudge()` from elsewhere (the `online` listener, `App.test.tsx`'s
 * "nudges ... online" test) actually starts a drain, which it only does once
 * the backoff-respecting `nudge()` (Finding 1) has nothing scheduled to
 * defer to.
 */
export const BACKOFF_START_MS = 2_000;
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

/**
 * Guards against acknowledging (and permanently deleting) a batch on the
 * strength of a response that merely parsed as JSON but isn't actually this
 * endpoint's contract — e.g. a captive portal or maintenance shim on the
 * plant network answering `200 {"status":"ok"}` instead of the server.
 */
function isBatchResponse(value: unknown): value is BatchResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { applied?: unknown }).applied === "number" &&
    typeof (value as { alreadyApplied?: unknown }).alreadyApplied === "boolean"
  );
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
 * server confirms it, so a lost response resends. Two things make that
 * actually safe, not just apparently safe:
 *
 * 1. The batch id — `<machineId>:<installId>:<highest outbox id in the
 *    batch>` — is deterministic for a GIVEN set of rows, and the server
 *    records it, so resending those exact rows is a no-op there. `installId`
 *    (`install-id.ts`) is a random identifier persisted in `station_meta`: it
 *    changes only when `station-mirror.db` itself is recreated, which is
 *    what keeps a device that lost just its local database — but kept
 *    `machineId`, which lives in `station.json` instead — from colliding
 *    with a batch key the server already recorded for the database it
 *    replaced (Finding 3: without this, the outbox's id counter restarting
 *    at 1 in the fresh database would silently reproduce an old key, and the
 *    server's `alreadyApplied: true` for it would delete brand-new scans).
 * 2. The set of rows a key names cannot silently grow. `pendingCeiling`
 *    pins the batch currently awaiting acknowledgement to its original
 *    `maxId`: a retry — the engine's own scheduled backoff attempt, or one
 *    a later nudge triggers — re-reads exactly that range (`readBatch`'s
 *    `ceilingId`), never a fresh `ORDER BY id LIMIT` read. While the queue
 *    holds fewer rows than `BATCH_SIZE` — the ordinary state on a
 *    continuously-draining line — a fresh read would otherwise pick up rows
 *    enqueued since the failed attempt and post them under a NEW key the
 *    server has never seen, applying the original rows a second time.
 *
 * A random id per attempt (instead of both of the above) would silently turn
 * every lost response into duplicated data.
 *
 * Exactly one drain runs at a time; `draining` is set synchronously before
 * the first await, the same discipline `createScanQueue` uses, because two
 * drains would read overlapping batches and race their acknowledgements.
 * `nudge()` also never starts a fresh drain while a retry is already
 * scheduled, so a scan arriving while the link is down cannot turn the
 * documented 2s→60s backoff into one POST attempt per scan — see its own
 * comment.
 */
export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const now = deps.now ?? (() => Date.now());
  let draining = false;
  let stopped = false;
  let requested = false;
  let lastSuccessAt: number | null = null;
  let backoffMs = BACKOFF_START_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let idleResolvers: (() => void)[] = [];
  // The `maxId` of the batch currently awaiting acknowledgement, or `null`
  // when no batch is in flight. Set right before the batch is posted, held
  // across every retry of that SAME batch, and cleared only once the server
  // has confirmed it — see the doc comment above and `readBatch`'s
  // `ceilingId` parameter.
  let pendingCeiling: number | null = null;
  // Resolved once per engine instance and cached: the install id never
  // changes for the life of a given local database, so there is no reason
  // to re-query `station_meta` for every batch.
  let installId: string | null = null;

  async function ensureInstallId(): Promise<string> {
    if (installId === null) installId = await getInstallId(deps.exec);
    return installId;
  }

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
      // These two branches deliberately live in different time domains and
      // must never be compared against each other — mixing them is exactly
      // the bug this replaces. `lastSuccessAt` is stamped from the injected
      // `now()`, so it is only meaningful measured against a later `now()`
      // from that same source. Before this engine has ever seen a success
      // there is no such stamp, so the only honest measure is the real age
      // of the oldest queued scan: `scanned_at` is a wall-clock ISO
      // timestamp, so it has to be measured against `Date.now()`, never
      // against the injected clock.
      //
      // No false-alarm risk on a healthy restart: state is published only
      // after the drain loop completes, so a device that reconnects and
      // drains successfully already has `lastSuccessAt` set by the time
      // this runs.
      if (lastSuccessAt !== null) {
        stuck = now() - lastSuccessAt >= STUCK_AFTER_MS;
      } else {
        const oldest = await oldestQueuedAt(deps.exec);
        const oldestMs = oldest === null ? NaN : Date.parse(oldest);
        // A missing or unparseable timestamp must never masquerade as "very
        // old" via NaN comparisons — treat it as not stuck rather than
        // warning spuriously.
        stuck = Number.isFinite(oldestMs) && Date.now() - oldestMs >= STUCK_AFTER_MS;
      }
    }
    deps.onState({ pending, lastSuccessAt, stuck });
  }

  async function drain(): Promise<void> {
    if (draining || stopped) return;
    draining = true;
    try {
      for (;;) {
        if (stopped) break;
        // A ceiling from a previous failed attempt on THIS batch re-reads
        // exactly that range; otherwise this is a plain fresh prefix.
        const batch = await readBatch(deps.exec, BATCH_SIZE, pendingCeiling);
        if (batch.length === 0) {
          // Only reachable with a stale ceiling if the rows it pinned were
          // somehow removed without going through `ackThrough` below — not
          // expected, but clearing it here avoids wedging every later drain
          // on a ceiling that can never again be satisfied.
          pendingCeiling = null;
          break;
        }

        const maxId = batch[batch.length - 1]!.id;
        // Pin BEFORE sending: if the post fails, every later attempt on this
        // batch — the scheduled retry, or a nudge that lands while one is
        // outstanding — must re-request exactly this id range, never a
        // fresh read that could have grown past it.
        pendingCeiling = maxId;
        try {
          const instId = await ensureInstallId();
          const res = await deps.client.post<BatchResponse>("/station/scans", {
            batchId: `${deps.machineId}:${instId}:${maxId}`,
            items: toPayload(batch),
          });
          if (!isBatchResponse(res)) {
            // Parsed fine but isn't this endpoint's contract — could be a
            // proxy/captive portal on the plant network. Fall into the
            // same failure path as a network error: do not ack.
            throw new Error("station: unexpected /station/scans response shape");
          }
          // `alreadyApplied` is a success: this exact batch is on the
          // server already, so holding on to it would wedge the queue
          // forever.
          await ackThrough(deps.exec, maxId);
          pendingCeiling = null;
          lastSuccessAt = now();
          backoffMs = BACKOFF_START_MS;
        } catch (err) {
          // Every failure here — network error, non-2xx, bad JSON, wrong
          // shape, or a terminal 4xx the server will never accept (e.g. a
          // shift it no longer owns, or a device re-enrolled into a
          // different tenant) — is retried indefinitely. This is
          // deliberate: a batch is never quarantined or dropped, because
          // losing scan data is worse than a stalled queue. That means a
          // permanently-rejected batch wedges the queue by design; the
          // `stuck` indicator below is what surfaces that to an operator.
          console.error("station: sync batch failed", err);
          scheduleRetry();
          break;
        }
      }
    } catch (err) {
      // readBatch can fail (e.g. device DB is locked or corrupt). ackThrough
      // failures are handled by the inner catch above and are safe: the batch
      // was already accepted, so the next drain resends the exact same
      // (ceiling-pinned) batch id and the server no-ops it. This catch
      // handles readBatch errors
      // and other device-database errors that must not escape as unhandled
      // rejections — every call site launches the drain with a discarded
      // promise, so an uncaught rejection would silently kill sync with the
      // indicator frozen at its last value.
      console.error("station: sync drain failed", err);
      scheduleRetry();
      try {
        await publishState();
      } catch (publishErr) {
        console.error("station: sync state publish failed", publishErr);
      }
    } finally {
      // Post-drain state publish. If it fails, do not retry the drain — all
      // batches that were ready to send have been sent or have exhausted retry.
      // A stale state report is benign; a false retry triggered by this publish
      // failure would not be.
      try {
        await publishState();
      } catch (publishErr) {
        console.error("station: sync state publish failed", publishErr);
      }

      draining = false;
      // Only continue immediately when nothing scheduled a retry during this
      // drain. If the last attempt failed, `retryTimer` is already set (by
      // `scheduleRetry` above) by the time this runs — continuing anyway
      // here would be exactly the backoff bypass `nudge()` also guards
      // against, just reached from the opposite direction (a nudge that
      // arrived WHILE this drain was running, rather than one that arrives
      // after it). Dropping a stale `requested` in that case is safe: the
      // scheduled retry performs a full drain of whatever is queued by the
      // time it fires, so no request is actually lost, only its timing.
      const shouldContinue = requested && !stopped && retryTimer === null;
      requested = false;
      if (shouldContinue) {
        void drain();
      } else {
        settleIdle();
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
      if (draining) {
        requested = true;
        return;
      }
      // A retry is already scheduled: let the backoff run its course
      // instead of hammering the server with one attempt per nudge (a scan,
      // the `online` listener, the heartbeat) while the link is down. The
      // scheduled attempt drains whatever is queued by the time it fires, so
      // nothing queued now is lost — only sent later than this particular
      // nudge asked for.
      if (retryTimer !== null) return;
      void drain();
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
