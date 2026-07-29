import type { StationClient } from "./api-client.js";
import { conflictCount, recordConflicts } from "./conflicts.js";
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
  /**
   * How many of this device's own scans lost ownership to an earlier scan
   * elsewhere. Not an alarm — the operator already saw a green verdict for
   * each one — so this is a quiet count, never something that interrupts.
   */
  conflicts: number;
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

/** One of this device's scans that lost ownership, as the server reports it. */
interface BatchConflict {
  codeHash: string;
  winningTerminalId: string | null;
  winningScannedAt: string;
}

interface BatchResponse {
  applied: number;
  alreadyApplied: boolean;
  conflicts?: BatchConflict[];
}

/**
 * `winningScannedAt` must be a string AND parse to a real instant. A
 * non-ISO string would otherwise ride through unchanged into
 * `conflicts_mirror` and blow up `ConflictList`'s `Intl.DateTimeFormat` at
 * render time (`new Date("garbage")` is an Invalid Date, and `.format()` on
 * one throws a `RangeError`) -- taking the whole list down for one bad
 * entry. `.filter(isBatchConflict)` already drops entries one at a time, so
 * this costs only the malformed conflict, never its batch-mates. That cost
 * is real, though: a dropped conflict is gone for good, since a resent
 * already-applied batch answers `conflicts: []` (see the module doc
 * comment above), so there is no second chance to record it.
 */
function isBatchConflict(value: unknown): value is BatchConflict {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.codeHash === "string" &&
    (typeof c.winningTerminalId === "string" || c.winningTerminalId === null) &&
    typeof c.winningScannedAt === "string" &&
    !Number.isNaN(Date.parse(c.winningScannedAt))
  );
}

/**
 * Guards against acknowledging (and permanently deleting) a batch on the
 * strength of a response that merely parsed as JSON but isn't actually this
 * endpoint's contract — e.g. a captive portal or maintenance shim on the
 * plant network answering `200 {"status":"ok"}` instead of the server.
 *
 * The two original fields stay REQUIRED: this guard is what stands between a
 * captive portal's `200 {"status":"ok"}` and an acknowledgement that
 * permanently deletes scans. `conflicts` is tolerated when absent or
 * malformed — a server that cannot describe conflicts must not cost the
 * device its delivery — and is filtered element-by-element where it is
 * consumed, not validated here.
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

const CEILING_META_KEY = "sync_pending_ceiling";

/**
 * Reads back the in-flight batch's pinned ceiling (see `pendingCeiling`
 * below), persisted in `station_meta` — the same key/value table
 * `hardware_config`, the roster slot pointer, and the install id already
 * use. This is what makes the ceiling survive not just the engine's own
 * scheduled retry within one process, but an app restart, crash, or update:
 * a brand-new engine, built over the same on-device database, seeds its
 * in-memory ceiling from here instead of starting at `null` and reopening a
 * plain fresh prefix read — see `createSyncEngine`'s doc comment for why
 * that gap is exactly what let a resend duplicate data server-side.
 */
async function loadPersistedCeiling(exec: SqlExecutor): Promise<number | null> {
  const rows = await exec.all<{ value: string | null }>(
    "SELECT value FROM station_meta WHERE key = ?",
    [CEILING_META_KEY],
  );
  const value = rows[0]?.value;
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Single-statement upsert — the only atomic unit `tauri-plugin-sql`'s pooled
 * connections actually give us (a device-side BEGIN/COMMIT spanning two
 * calls is not a transaction; see `outbox.ts`'s `ackThrough` doc comment).
 * Called BEFORE the batch is posted, so a crash between this write landing
 * and the response arriving still leaves the ceiling pinned for whichever
 * process resends next.
 */
async function savePersistedCeiling(exec: SqlExecutor, id: number): Promise<void> {
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [CEILING_META_KEY, String(id)],
  );
}

/** Single statement; called once the server has confirmed the batch. */
async function clearPersistedCeiling(exec: SqlExecutor): Promise<void> {
  await exec.run("DELETE FROM station_meta WHERE key = ?", [CEILING_META_KEY]);
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
 * 2. The set of rows a key names cannot silently grow, including across a
 *    restart. `pendingCeiling` pins the batch currently awaiting
 *    acknowledgement to its original `maxId`: a retry — the engine's own
 *    scheduled backoff attempt, one a later nudge triggers, or the very
 *    first drain of a BRAND-NEW engine (an app restart, crash, or update) —
 *    re-reads exactly that range (`readBatch`'s `ceilingId`), never a fresh
 *    `ORDER BY id LIMIT` read. While the queue holds fewer rows than
 *    `BATCH_SIZE` — the ordinary state on a continuously-draining line — a
 *    fresh read would otherwise pick up rows enqueued since the failed
 *    attempt and post them under a NEW key the server has never seen,
 *    applying the original rows a second time. The ceiling is therefore not
 *    just an in-memory guard: it is persisted in `station_meta` with a
 *    single-statement upsert BEFORE the batch is sent, cleared with a single
 *    statement once the server confirms, and reloaded from there by any
 *    engine that starts with nothing in memory yet — see
 *    `loadPersistedCeiling`/`savePersistedCeiling`/`clearPersistedCeiling`
 *    above. That is what makes this survive not only the process's own
 *    retries but a restart mid-batch.
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
  // when no batch is in flight. Set right before the batch is posted (and
  // persisted to `station_meta` at that same point — see
  // `savePersistedCeiling`), held across every retry of that SAME batch,
  // and cleared — in memory AND in `station_meta` — only once the server
  // has confirmed it. See the doc comment above and `readBatch`'s
  // `ceilingId` parameter.
  let pendingCeiling: number | null = null;
  // Whether `pendingCeiling` has been seeded from `station_meta` yet. A
  // freshly constructed engine (a new process after a restart, crash, or
  // update) starts with `pendingCeiling` unset in memory even though a
  // previous process may have persisted one; this makes the FIRST drain
  // load it before doing anything else, instead of every engine's first
  // batch after a restart silently reopening a plain fresh prefix read.
  let ceilingLoaded = false;
  // Resolved once per engine instance and cached: the install id never
  // changes for the life of a given local database, so there is no reason
  // to re-query `station_meta` for every batch.
  let installId: string | null = null;

  async function ensureInstallId(): Promise<string> {
    if (installId === null) installId = await getInstallId(deps.exec);
    return installId;
  }

  async function ensurePendingCeiling(): Promise<number | null> {
    if (!ceilingLoaded) {
      pendingCeiling = await loadPersistedCeiling(deps.exec);
      ceilingLoaded = true;
    }
    return pendingCeiling;
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
      // The two comparisons below deliberately live in different time
      // domains and must never be compared against each other — mixing them
      // is exactly the bug this replaces. `lastSuccessAt` is stamped from
      // the injected `now()`, so it is only meaningful measured against a
      // later `now()` from that same source. The oldest queued scan's age,
      // by contrast, is always measured against `Date.now()`: `scanned_at`
      // is a wall-clock ISO timestamp, never relative to the injected clock.
      const oldest = await oldestQueuedAt(deps.exec);
      const oldestMs = oldest === null ? NaN : Date.parse(oldest);
      // A missing or unparseable timestamp must never masquerade as "very
      // old" via NaN comparisons — treat it as not stuck rather than
      // warning spuriously.
      const oldestQueuedIsStale =
        Number.isFinite(oldestMs) && Date.now() - oldestMs >= STUCK_AFTER_MS;

      // No false-alarm risk on a healthy restart: state is published only
      // after the drain loop completes, so a device that reconnects and
      // drains successfully already has `lastSuccessAt` set by the time
      // this runs.
      if (lastSuccessAt !== null) {
        // Finding 4: `lastSuccessAt` alone goes stale merely from IDLE time
        // with an empty, healthy queue — it says nothing about how long any
        // CURRENTLY queued scan has actually failed to move. Requiring the
        // oldest queued scan to ALSO be stale on the wall clock is what
        // stops the first newly recorded scan's first failed upload from
        // being reported stuck immediately just because the device happened
        // to sit idle for a while beforehand.
        stuck = oldestQueuedIsStale && now() - lastSuccessAt >= STUCK_AFTER_MS;
      } else {
        stuck = oldestQueuedIsStale;
      }
    }
    const conflicts = await conflictCount(deps.exec);
    deps.onState({ pending, lastSuccessAt, stuck, conflicts });
  }

  async function drain(): Promise<void> {
    if (draining || stopped) return;
    draining = true;
    try {
      for (;;) {
        if (stopped) break;
        // A ceiling from a previous failed attempt on THIS batch — whether
        // pinned earlier in this same process or persisted by a process
        // that pinned it and then never got to clear it — re-reads exactly
        // that range; otherwise this is a plain fresh prefix.
        const ceiling = await ensurePendingCeiling();
        const batch = await readBatch(deps.exec, BATCH_SIZE, ceiling);
        if (batch.length === 0) {
          if (ceiling !== null) {
            // Only reachable with a stale ceiling if the rows it pinned were
            // somehow removed without going through `ackThrough` below (or
            // were already acknowledged by whichever process posted them,
            // and this one never learned that) — not expected, but clearing
            // it here (in memory and in `station_meta`) avoids wedging every
            // later drain on a ceiling that can never again be satisfied.
            // `continue`, not `break`: any rows queued above the (now
            // cleared) ceiling must drain in this same pass, not wait for
            // the next nudge or the 15-second heartbeat.
            pendingCeiling = null;
            await clearPersistedCeiling(deps.exec);
            continue;
          }
          break;
        }

        const maxId = batch[batch.length - 1]!.id;
        // Pin BEFORE sending — in memory AND in `station_meta` (a single
        // upsert; never a multi-statement transaction, see the module doc
        // comment) — so that if the post fails, or the whole process dies
        // before it completes, every later attempt on this batch — the
        // scheduled retry, a nudge that lands while one is outstanding, or a
        // brand-new engine's first drain after a restart — re-requests
        // exactly this id range, never a fresh read that could have grown
        // past it.
        pendingCeiling = maxId;
        try {
          await savePersistedCeiling(deps.exec, maxId);
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
          // Filtered element-by-element, not all-or-nothing: dropping only
          // the malformed entry (Finding 2) keeps the rest of this batch's
          // conflicts intact. That matters more here than it would somewhere
          // safety-critical — this is a courtesy count, not delivery — and
          // discarding the whole array over one bad element would
          // under-report further than a single malformed field warrants;
          // nothing about one malformed entry says anything about the
          // others in the same response.
          const reported = Array.isArray(res.conflicts)
            ? res.conflicts.filter(isBatchConflict)
            : [];
          if (reported.length > 0) {
            // Recorded BEFORE the ack, on purpose: `recordConflicts` and
            // `ackThrough` are two separate device-side writes (this pool
            // has no multi-call transaction — see the module doc comment),
            // so a crash between them is possible either way. Persisting
            // conflicts first means a crash there simply resends the batch;
            // the server already applied it and answers `alreadyApplied`
            // with an empty `conflicts` list, and the ones already stored
            // locally are untouched (recordConflicts is an idempotent
            // upsert). The other order would lose them: acking first and
            // then crashing before this write deletes the outbox rows that
            // were the only local record a conflict existed for that batch,
            // and the resend that would have carried them again never
            // happens because the server no-ops an already-applied batch.
            //
            // Isolated in its own try/catch, separate from the network/shape
            // catch below (Finding 1): a failure here has nothing to do with
            // whether the server received the batch — it already did,
            // durably, before this response ever arrived — so retrying
            // protects nothing and would instead wedge every subsequent scan
            // on this terminal behind a batch that can never ack. The floor
            // rule (design brief 04) is that nothing competes with scan
            // delivery, and a courtesy count is exactly the kind of thing
            // that must not. The accepted trade: a failed recording loses
            // those conflicts on this device permanently — a resend of an
            // already-applied batch reports `conflicts: []` (the server
            // decides conflicts at ingest and never recomputes them for a
            // retry), so there is no second chance on this device. A
            // silently under-reported courtesy count beats a terminal that
            // cannot deliver scans, and the cabinet remains the
            // authoritative record either way.
            try {
              await recordConflicts(deps.exec, reported, new Date(now()).toISOString());
            } catch (err) {
              console.error("station: recording conflicts failed", err);
            }
          }
          // `alreadyApplied` is a success: this exact batch is on the
          // server already, so holding on to it would wedge the queue
          // forever.
          await ackThrough(deps.exec, maxId);
          pendingCeiling = null;
          await clearPersistedCeiling(deps.exec);
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
