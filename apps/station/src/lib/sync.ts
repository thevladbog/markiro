import { MAX_BOX_CLOSURES_PER_SYNC_BATCH } from "@markiro/domain";
import type { StationClient } from "./api-client.js";
import { conflictCount, recordConflicts } from "./conflicts.js";
import { getInstallId } from "./install-id.js";
import type { SqlExecutor } from "./mirror.js";
import { ackThrough, oldestQueuedAt, outboxDepth, readBatch, type OutboxItem } from "./outbox.js";
import { addRange, remaining, type PoolRange } from "./sscc-pool.js";
import {
  ackExceptionsThrough,
  exceptionDepth,
  oldestExceptionAt,
  readExceptions,
  type PendingException,
} from "./box-exceptions-mirror.js";

export { MAX_BOX_CLOSURES_PER_SYNC_BATCH };

/** Scans per request. Small enough to survive a flaky link and to retry cheaply. */
export const BATCH_SIZE = 100;
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
  /**
   * Unburned SSCC serials left in this device's local pool (box ranges,
   * extension digit 0), summed across every range it holds. Zero when the
   * device has never received a range at all, same as a dry pool — the
   * operator-facing signal (a later slice) has no reason to tell those
   * apart.
   */
  serialsLeft: number;
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

/** A block of box-range serials the server is topping this device's pool up with. */
type BatchSsccBlock = Omit<PoolRange, "nextSerial">;

interface BatchResponse {
  applied: number;
  alreadyApplied: boolean;
  conflicts?: BatchConflict[];
  ssccBlock?: BatchSsccBlock;
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
 * Same discipline as `isBatchConflict`, for the same reason: `ssccBlock` is
 * optional, and a malformed one must cost only the top-up, never the batch's
 * ack. Checked at the point of consumption (below), not folded into
 * `isBatchResponse` itself — that guard's two required fields are what
 * stand between a captive portal and a permanent delete, and this is not
 * that; a server that sends a top-up in a shape this device does not
 * recognize should still see its batch acknowledged.
 */
function isBatchSsccBlock(value: unknown): value is BatchSsccBlock {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.issuerPrefix === "string" &&
    typeof b.extensionDigit === "number" &&
    typeof b.fromSerial === "number" &&
    typeof b.toSerial === "number"
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
    boxId: i.boxId,
    operatorId: i.operatorId,
  }));
}

function toExceptionPayload(exceptions: PendingException[]) {
  return exceptions.map((exception) => ({
    kind: exception.kind,
    boxId: exception.boxId,
    codeHash: exception.codeHash,
    shiftId: exception.shiftId,
    terminalId: exception.terminalId,
    operatorId: exception.operatorId,
    reason: exception.reason,
    occurredAt: exception.at,
  }));
}

/** Keeps the contiguous id prefix required by range-based acknowledgements. */
function takePrefix<T>(rows: T[], keep: (row: T) => boolean): T[] {
  const stop = rows.findIndex((row) => !keep(row));
  return stop === -1 ? rows : rows.slice(0, stop);
}

/** A closed-but-unreported box, as read off this device's own `boxes_mirror` row. */
interface BoxClosureRow {
  boxId: string;
  shiftId: string;
  terminalId: string | null;
  sscc: string;
  closedAt: string;
  operatorId: string | null;
  /**
   * Whether the closed box's printed label has been scanned back and
   * matched, or the operator explicitly chose to skip that (Task 13 review,
   * Finding 6) -- read straight off `boxes_mirror`'s own `print_verified_at`/
   * `print_skipped_at` columns (Task 9), which is where `PrintVerification`'s
   * `onVerified`/`onSkip` paths write them. Null on either just means "not
   * yet resolved" -- an ack can race the operator's decision (the box is
   * typically acked within seconds of closing, often before the prompt is
   * even answered), and that is fine: there is no requirement that the
   * outcome reach the server before the ack, only that it eventually can.
   */
  printVerifiedAt: string | null;
  printSkippedAt: string | null;
  /** SQLite's own rowid -- see `readClosedUnackedBoxes`'s doc comment. */
  rowid: number;
}

/**
 * Every box this device has closed but not yet had acknowledged, oldest
 * first -- capped at `limit` (the API's own `syncBatchSchema.boxes.max()`,
 * `MAX_BOX_CLOSURES_PER_SYNC_BATCH`) so a station that closes more boxes
 * offline than one batch may carry never assembles a payload the server
 * rejects outright: without this cap, an over-limit batch would 400 every
 * time (Zod's `.max()`), and since the drain treats every error as
 * retryable and never drops data (see the module doc comment), the
 * identical oversized payload would retry forever, wedging both box
 * closures and item delivery on that device. The drain loop's own `for`
 * loop is what delivers anything left over: once this capped batch acks,
 * the next iteration reads fresh and picks up the remainder.
 *
 * `ceilingRowid`, when given, additionally requires `rowid <= ceilingRowid`
 * -- the same discipline `readBatch`'s `ceilingId` applies to the outbox
 * (see `pendingBoxCeiling`'s doc comment in `createSyncEngine` for why a box
 * closure needs this too, despite being idempotent on the server): a retry
 * of a batch already in flight must re-read the EXACT box set that batch's
 * id was computed from, never a fresh read that could have grown to include
 * a box that closed during the backoff window. Omitted (or `null`), this is
 * a plain "oldest `limit` rows" read, used only when no box batch is
 * currently pinned.
 *
 * Reports `shiftId`/`terminalId` straight off the box's OWN row, never
 * whatever the device would consider "current" at drain time: this engine
 * has no notion of a "current" shift or terminal at all (it drains the
 * WHOLE device outbox, which can span a shift change), and terminalId
 * (`deviceId`) lives in `station.json`, not this SQLite mirror, so it can
 * change independently of a box still open in the local database. A box
 * spanning either change must still report the identity it was opened
 * under, or the server's four-column match can never find it.
 */
async function readClosedUnackedBoxes(
  exec: SqlExecutor,
  limit: number,
  ceilingRowid?: number | null,
): Promise<BoxClosureRow[]> {
  const rows =
    ceilingRowid != null
      ? await exec.all<{
          box_id: string;
          shift_id: string;
          terminal_id: string | null;
          sscc: string;
          closed_at: string;
          closed_by: string | null;
          print_verified_at: string | null;
          print_skipped_at: string | null;
          rowid: number;
        }>(
          `SELECT rowid, box_id, shift_id, terminal_id, sscc, closed_at, closed_by,
                  print_verified_at, print_skipped_at
             FROM boxes_mirror
            WHERE closed_at IS NOT NULL AND acked_at IS NULL AND rowid <= ?
            ORDER BY rowid LIMIT ?`,
          [ceilingRowid, limit],
        )
      : await exec.all<{
          box_id: string;
          shift_id: string;
          terminal_id: string | null;
          sscc: string;
          closed_at: string;
          closed_by: string | null;
          print_verified_at: string | null;
          print_skipped_at: string | null;
          rowid: number;
        }>(
          `SELECT rowid, box_id, shift_id, terminal_id, sscc, closed_at, closed_by,
                  print_verified_at, print_skipped_at
             FROM boxes_mirror
            WHERE closed_at IS NOT NULL AND acked_at IS NULL
            ORDER BY rowid LIMIT ?`,
          [limit],
        );
  return rows.map((r) => ({
    boxId: r.box_id,
    shiftId: r.shift_id,
    terminalId: r.terminal_id,
    sscc: r.sscc,
    closedAt: r.closed_at,
    operatorId: r.closed_by,
    printVerifiedAt: r.print_verified_at,
    printSkippedAt: r.print_skipped_at,
    rowid: r.rowid,
  }));
}

function toBoxPayload(boxes: BoxClosureRow[]) {
  return boxes.map((b) => ({
    boxId: b.boxId,
    shiftId: b.shiftId,
    terminalId: b.terminalId,
    sscc: b.sscc,
    closedAt: b.closedAt,
    operatorId: b.operatorId,
    printVerifiedAt: b.printVerifiedAt,
    printSkippedAt: b.printSkippedAt,
  }));
}

/**
 * A compact identity for a set of box closures, folded into `batchId` so a
 * retry's key changes whenever the SET actually being sent changes (Finding
 * 1) -- either because a box was added (the ceiling rowid grows) or because
 * an already-included box's print-verification outcome resolved (Task 13
 * review, Finding 1's `acked_at`-clearing resend, which reuses the SAME
 * rowid). One character per box -- `u`nresolved, `v`erified, or `s`kipped --
 * keeps this well within `batchId`'s 200-character budget even at
 * `MAX_BOX_CLOSURES_PER_SYNC_BATCH` boxes, and each box transitions its
 * character exactly once (an outcome is terminal), so this cannot cycle back
 * to a signature already used for a genuinely different set.
 */
function boxSetSignature(boxes: BoxClosureRow[]): string {
  const ceiling = boxes[boxes.length - 1]!.rowid;
  const outcomes = boxes
    .map((b) => (b.printVerifiedAt !== null ? "v" : b.printSkippedAt !== null ? "s" : "u"))
    .join("");
  return `${ceiling}:${outcomes}`;
}

/**
 * Marks each of these boxes acknowledged -- CONDITIONALLY (CodeRabbit PR33
 * review, Finding 6): only if its print-verification outcome still matches
 * what was actually read into the payload this ack is FOR, at
 * payload-build time (`boxes`, the exact rows `readClosedUnackedBoxes`
 * returned for this send). One UPDATE per box, not a single IN-list
 * statement, because each box's own `printVerifiedAt`/`printSkippedAt` at
 * that moment can differ from its batch-mates', so one shared WHERE cannot
 * express every box's own condition at once.
 *
 * The race this closes: `markPrintVerified`/`markPrintSkipped` can resolve
 * a box's outcome AFTER its closure has already been read into an
 * in-flight upload's payload but BEFORE that upload's response is
 * acknowledged. Both of those functions clear `acked_at` on their own write
 * (see their own doc comments) specifically to re-open a resend window --
 * but an unconditional ack here would immediately re-close that SAME
 * window on the strength of a response that was for the OLD (still-null)
 * outcome, permanently losing the just-recorded resolution (it would never
 * be read by `readClosedUnackedBoxes` again). Gating on the STALE values
 * captured at payload-build time means: if the row's outcome is unchanged
 * since then, this ack lands normally; if it changed in that window, this
 * ack is correctly a no-op -- the row stays unacked and the next drain
 * resends it, carrying the real, now-resolved outcome.
 *
 * `IS`, not `=`, for both comparisons: SQLite's `=` is never true against
 * NULL (three-valued logic), so a box whose outcome was -- and still is --
 * unresolved (both columns null) would never match its own WHERE under
 * `=`. `IS` is null-safe, so `print_verified_at IS NULL` correctly matches
 * a still-null column.
 */
async function ackBoxes(exec: SqlExecutor, boxes: BoxClosureRow[], ackedAt: string): Promise<void> {
  for (const box of boxes) {
    await exec.run(
      `UPDATE boxes_mirror SET acked_at = ?
       WHERE box_id = ? AND print_verified_at IS ? AND print_skipped_at IS ?`,
      [ackedAt, box.boxId, box.printVerifiedAt, box.printSkippedAt],
    );
  }
}

/**
 * The issuer prefix this device's local pool is keyed under, or null if it
 * has never received a box range at all. A device holds at most one in
 * practice (`StationBundle.sscc` hands down a single prefix), so the lowest
 * one on an otherwise-unexpected multi-prefix device is as good a choice as
 * any -- this is a reporting figure, not an allocation decision.
 */
async function currentIssuerPrefix(exec: SqlExecutor): Promise<string | null> {
  const rows = await exec.all<{ issuer_prefix: string }>(
    "SELECT issuer_prefix FROM sscc_pool WHERE extension_digit = 0 ORDER BY issuer_prefix LIMIT 1",
  );
  return rows[0]?.issuer_prefix ?? null;
}

/** Serials left in the box pool (extension digit 0), for `SyncState` and the request body. */
async function computeSerialsLeft(exec: SqlExecutor): Promise<number> {
  const issuerPrefix = await currentIssuerPrefix(exec);
  return issuerPrefix === null ? 0 : remaining(exec, issuerPrefix, 0);
}

const CEILING_META_KEY = "sync_pending_ceiling";
/**
 * The box-closure counterpart of `CEILING_META_KEY` (Finding 1): pins the
 * `boxes_mirror` rowid ceiling of the box set currently in flight, the same
 * way `CEILING_META_KEY` pins the outbox `id` ceiling of the items in
 * flight. Without this, a batch that carries items keys its `batchId` off
 * `CEILING_META_KEY`'s `maxId` alone; if a NEW box closes while that batch
 * awaits acknowledgement, a retry would resend the identical `batchId` with
 * a grown box set. The server claims batch ids in `sync_batches` and
 * short-circuits an already-claimed one with `alreadyApplied` BEFORE its own
 * box-closures loop (`station-scans.service.ts`), so that new closure would
 * never actually be applied server-side -- yet this device's `ackBoxes` (see
 * `drain` below) marks it acknowledged anyway, losing it permanently. Pinning
 * the box set separately, exactly like the item ceiling, keeps a retry of
 * THIS batch scoped to the box set it was originally computed from; a box
 * that closes afterward rides a later, distinct batch instead.
 */
const BOX_CEILING_META_KEY = "sync_pending_box_ceiling";
const EXCEPTION_CEILING_META_KEY = "sync_pending_exception_ceiling";
const BATCH_ID_META_KEY = "sync_pending_batch_id";

async function loadPersistedValue(exec: SqlExecutor, key: string): Promise<string | null> {
  const rows = await exec.all<{ value: string | null }>(
    "SELECT value FROM station_meta WHERE key = ?",
    [key],
  );
  return rows[0]?.value ?? null;
}

/**
 * Reads back an in-flight batch's pinned ceiling (see `pendingCeiling`/
 * `pendingBoxCeiling` below), persisted in `station_meta` under `key` — the
 * same key/value table `hardware_config`, the roster slot pointer, and the
 * install id already use. This is what makes a ceiling survive not just the
 * engine's own scheduled retry within one process, but an app restart,
 * crash, or update: a brand-new engine, built over the same on-device
 * database, seeds its in-memory ceiling from here instead of starting at
 * `null` and reopening a plain fresh read — see `createSyncEngine`'s doc
 * comment for why that gap is exactly what let a resend duplicate data
 * server-side.
 */
async function loadPersistedCeiling(exec: SqlExecutor, key: string): Promise<number | null> {
  const value = await loadPersistedValue(exec, key);
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
async function savePersistedCeiling(exec: SqlExecutor, key: string, id: number): Promise<void> {
  await savePersistedValue(exec, key, String(id));
}

async function savePersistedValue(exec: SqlExecutor, key: string, value: string): Promise<void> {
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** Single statement; called once the server has confirmed the batch. */
async function clearPersistedCeiling(exec: SqlExecutor, key: string): Promise<void> {
  await exec.run("DELETE FROM station_meta WHERE key = ?", [key]);
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
  // The `boxes_mirror` rowid ceiling of the box set currently awaiting
  // acknowledgement (Finding 1) -- `pendingCeiling`'s exact counterpart for
  // box closures, pinned and persisted the same way, for the same reason:
  // without it, a batch that also carries items keys its `batchId` off
  // `pendingCeiling` alone, so a box that closes while that batch is in
  // flight would silently ride an unchanged retry key straight past the
  // server's already-claimed-batch short-circuit. See `BOX_CEILING_META_KEY`
  // above and `readClosedUnackedBoxes`'s `ceilingRowid` parameter.
  let pendingBoxCeiling: number | null = null;
  // `ceilingLoaded`'s exact counterpart for `pendingBoxCeiling`.
  let boxCeilingLoaded = false;
  // Exception facts need the same persisted exact-set guarantee: otherwise
  // a restart can replay an acknowledged audit fact under a newly-grown key.
  let pendingExceptionCeiling: number | null = null;
  let exceptionCeilingLoaded = false;
  let pendingBatchId: string | null = null;
  let batchIdLoaded = false;
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
      pendingCeiling = await loadPersistedCeiling(deps.exec, CEILING_META_KEY);
      ceilingLoaded = true;
    }
    return pendingCeiling;
  }

  /** `ensurePendingCeiling`'s exact counterpart for `pendingBoxCeiling`. */
  async function ensurePendingBoxCeiling(): Promise<number | null> {
    if (!boxCeilingLoaded) {
      pendingBoxCeiling = await loadPersistedCeiling(deps.exec, BOX_CEILING_META_KEY);
      boxCeilingLoaded = true;
    }
    return pendingBoxCeiling;
  }

  async function ensurePendingExceptionCeiling(): Promise<number | null> {
    if (!exceptionCeilingLoaded) {
      pendingExceptionCeiling = await loadPersistedCeiling(deps.exec, EXCEPTION_CEILING_META_KEY);
      exceptionCeilingLoaded = true;
    }
    return pendingExceptionCeiling;
  }

  async function ensurePendingBatchId(): Promise<string | null> {
    if (!batchIdLoaded) {
      pendingBatchId = await loadPersistedValue(deps.exec, BATCH_ID_META_KEY);
      batchIdLoaded = true;
    }
    return pendingBatchId;
  }

  function settleIdle() {
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  async function publishState(): Promise<void> {
    const [scanPending, exceptionPending, boxPendingRows] = await Promise.all([
      outboxDepth(deps.exec),
      exceptionDepth(deps.exec),
      deps.exec.all<{ n: number; oldest: string | null }>(
        `SELECT COUNT(*) AS n, MIN(closed_at) AS oldest
           FROM boxes_mirror WHERE closed_at IS NOT NULL AND acked_at IS NULL`,
      ),
    ]);
    const boxPending = boxPendingRows[0]?.n ?? 0;
    const pending = scanPending + exceptionPending + boxPending;
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
      const [oldestScan, oldestException] = await Promise.all([
        oldestQueuedAt(deps.exec),
        oldestExceptionAt(deps.exec),
      ]);
      const oldest =
        [oldestScan, oldestException, boxPendingRows[0]?.oldest ?? null]
          .filter((value): value is string => value !== null)
          .sort()[0] ?? null;
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
    const serialsLeft = await computeSerialsLeft(deps.exec);
    deps.onState({ pending, lastSuccessAt, stuck, conflicts, serialsLeft });
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
        let batch = await readBatch(deps.exec, BATCH_SIZE, ceiling);
        // Boxes ride along independently of the outbox ceiling above (see
        // `readClosedUnackedBoxes`'s doc comment) -- a shift's last box can
        // close with nothing left queued, and that closure must still reach
        // the server without waiting for some LATER scan to give the drain
        // a reason to run. Pinned to its OWN ceiling (Finding 1), the same
        // way `batch` is pinned to `ceiling`: a retry of this same attempt
        // must re-read the exact box set it was keyed to, never a fresh read
        // that could have grown to include a box closed during the backoff
        // window. Capped at `MAX_BOX_CLOSURES_PER_SYNC_BATCH` (Finding 2) so
        // this device can never assemble a payload the server's own
        // `syncBatchSchema.boxes.max()` would reject outright.
        const boxCeiling = await ensurePendingBoxCeiling();
        const boxes = await readClosedUnackedBoxes(
          deps.exec,
          MAX_BOX_CLOSURES_PER_SYNC_BATCH,
          boxCeiling,
        );
        const exceptionCeiling = await ensurePendingExceptionCeiling();
        await ensurePendingBatchId();
        let exceptions = await readExceptions(deps.exec, BATCH_SIZE, exceptionCeiling);

        // Corrections and scans share one logical timeline even though they
        // live in separate SQLite tables. On a fresh attempt, send only the
        // chronological prefix from whichever channel is oldest. This keeps
        // an offline scan -> undo/clear -> rescan sequence in that order,
        // instead of applying the newer rescan and then releasing it in one
        // mixed server transaction. Retries skip this split because their
        // persisted ceilings already pin the exact selected prefix.
        if (pendingBatchId === null && batch.length > 0 && exceptions.length > 0) {
          const firstScanAt = Date.parse(batch[0]!.scannedAt);
          const firstExceptionAt = Date.parse(exceptions[0]!.at);
          if (!Number.isFinite(firstScanAt)) {
            exceptions = [];
          } else if (!Number.isFinite(firstExceptionAt)) {
            batch = [];
          } else if (firstScanAt <= firstExceptionAt) {
            batch = takePrefix(batch, (item) => Date.parse(item.scannedAt) <= firstExceptionAt);
            exceptions = [];
          } else {
            exceptions = takePrefix(exceptions, (item) => Date.parse(item.at) < firstScanAt);
            batch = [];
          }
        }
        if (batch.length === 0 && boxes.length === 0 && exceptions.length === 0) {
          if (
            ceiling !== null ||
            boxCeiling !== null ||
            exceptionCeiling !== null ||
            pendingBatchId !== null
          ) {
            // Only reachable with a stale ceiling if the rows it pinned were
            // somehow removed without going through `ackThrough`/`ackBoxes`
            // below (or were already acknowledged by whichever process
            // posted them, and this one never learned that) — not expected,
            // but clearing it here (in memory and in `station_meta`) avoids
            // wedging every later drain on a ceiling that can never again be
            // satisfied. `continue`, not `break`: any rows queued above the
            // (now cleared) ceiling must drain in this same pass, not wait
            // for the next nudge or the 15-second heartbeat.
            pendingCeiling = null;
            pendingBoxCeiling = null;
            pendingExceptionCeiling = null;
            pendingBatchId = null;
            await clearPersistedCeiling(deps.exec, CEILING_META_KEY);
            await clearPersistedCeiling(deps.exec, BOX_CEILING_META_KEY);
            await clearPersistedCeiling(deps.exec, EXCEPTION_CEILING_META_KEY);
            await clearPersistedCeiling(deps.exec, BATCH_ID_META_KEY);
            continue;
          }
          break;
        }

        // A zero ceiling explicitly pins an EMPTY channel. This matters when
        // another channel forms the batch: after a crash, a null ceiling
        // would read fresh rows into the already-persisted batch identity.
        const maxId = batch.length > 0 ? batch[batch.length - 1]!.id : null;
        const newBoxCeiling = boxes.length > 0 ? boxes[boxes.length - 1]!.rowid : null;
        const newExceptionCeiling =
          exceptions.length > 0 ? exceptions[exceptions.length - 1]!.id : null;
        // Pin BEFORE sending — in memory AND in `station_meta` (a single
        // upsert; never a multi-statement transaction, see the module doc
        // comment) — so that if the post fails, or the whole process dies
        // before it completes, every later attempt on this batch — the
        // scheduled retry, a nudge that lands while one is outstanding, or a
        // brand-new engine's first drain after a restart — re-requests
        // exactly this id range (and exactly these box/exception sets), never
        // a fresh read that could have grown past it.
        pendingCeiling = maxId ?? 0;
        pendingBoxCeiling = newBoxCeiling ?? 0;
        pendingExceptionCeiling = newExceptionCeiling ?? 0;
        try {
          await savePersistedCeiling(deps.exec, CEILING_META_KEY, pendingCeiling);
          await savePersistedCeiling(deps.exec, BOX_CEILING_META_KEY, pendingBoxCeiling);
          await savePersistedCeiling(
            deps.exec,
            EXCEPTION_CEILING_META_KEY,
            pendingExceptionCeiling,
          );
          const instId = await ensureInstallId();
          // A batch's box set (when non-empty) is folded into `batchId`
          // (Finding 1) via `boxSetSignature`, on top of `maxId` when items
          // are ALSO present: pinning `pendingCeiling` alone is not enough
          // to protect a box that closes while an ITEM batch is in flight,
          // because `maxId` does not change just because the box set grew,
          // and the server claims batch ids in `sync_batches` and
          // short-circuits an already-claimed one with `alreadyApplied`
          // BEFORE its own box-closures loop (`station-scans.service.ts`) --
          // so a retry that silently balloons its box set under an unchanged
          // key would never have that new closure actually applied
          // server-side, while this device's `ackBoxes` marks it
          // acknowledged anyway. `pendingBoxCeiling` above already stops the
          // SET from growing mid-retry; folding its signature into `batchId`
          // is what also lets the NEXT batch (once this one clears) claim a
          // key of its own, and what already gave the boxes-only branch
          // (`maxId === null`) a distinct key across a print-verification
          // outcome resolving (Task 13 review, second wave) -- see
          // `boxSetSignature`'s own doc comment.
          const boxSuffix = boxes.length > 0 ? `:box:${boxSetSignature(boxes)}` : "";
          const exceptionSuffix =
            newExceptionCeiling !== null ? `:exception:${newExceptionCeiling}` : "";
          const generatedBatchId =
            maxId !== null
              ? `${deps.machineId}:${instId}:${maxId}${boxSuffix}${exceptionSuffix}`
              : `${deps.machineId}:${instId}${boxSuffix}${exceptionSuffix}`;
          const batchId = (await ensurePendingBatchId()) ?? generatedBatchId;
          if (pendingBatchId === null) {
            pendingBatchId = batchId;
            await savePersistedValue(deps.exec, BATCH_ID_META_KEY, batchId);
          }
          const serialsLeft = await computeSerialsLeft(deps.exec);
          const res = await deps.client.post<BatchResponse>("/station/scans", {
            batchId,
            items: toPayload(batch),
            boxes: toBoxPayload(boxes),
            exceptions: toExceptionPayload(exceptions),
            serialsLeft,
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
              // A still-open box corrects itself: the operator simply scans
              // one more item. A CLOSED box is taped and labelled, so it
              // stays as printed and ends one position short — the cabinet
              // is where that surfaces. This is the same trade the server
              // makes when it marks a box item displaced rather than
              // deleting it. Same try/catch as `recordConflicts` above, for
              // the same reason: this is bookkeeping, not delivery.
              for (const c of reported) {
                await deps.exec.run(
                  `UPDATE codes_mirror SET box_id = NULL
                         WHERE code_hash = ?
                           AND box_id IN (SELECT box_id FROM boxes_mirror WHERE closed_at IS NULL)`,
                  [c.codeHash],
                );
              }
            } catch (err) {
              console.error("station: recording conflicts failed", err);
            }
          }
          // Applied AFTER the validated response and BEFORE the ack, in its
          // own try/catch: a pool top-up that fails must not block delivery,
          // for the same reason a failed conflict recording does not (see
          // above). The device simply runs on what it has; the next
          // response carries another block. Losing one block costs at most
          // some burnt numbers, and SSCCs need not be contiguous.
          if (res.ssccBlock && isBatchSsccBlock(res.ssccBlock)) {
            try {
              await addRange(deps.exec, res.ssccBlock);
            } catch (err) {
              console.error("station: applying serial block failed", err);
            }
          }
          // `alreadyApplied` is a success: this exact batch is on the
          // server already, so holding on to it would wedge the queue
          // forever.
          if (maxId !== null) {
            await ackThrough(deps.exec, maxId);
          }
          if (boxes.length > 0) {
            // `boxes` itself -- not just the ids -- so the ack can gate each
            // row on the outcome fields actually read into THIS payload
            // (Finding 6): see `ackBoxes`'s own doc comment.
            await ackBoxes(deps.exec, boxes, new Date(now()).toISOString());
          }
          if (newExceptionCeiling !== null) {
            await ackExceptionsThrough(deps.exec, newExceptionCeiling);
          }
          // Clear the identity first, then its ceilings. A crash in between
          // leaves stale ceilings that exclude newer rows and are safely
          // discarded by the empty-prefix branch above. The reverse order
          // could expose newer rows under an already-applied batch id.
          await clearPersistedCeiling(deps.exec, BATCH_ID_META_KEY);
          pendingBatchId = null;
          if (pendingCeiling !== null) await clearPersistedCeiling(deps.exec, CEILING_META_KEY);
          if (pendingBoxCeiling !== null) {
            await clearPersistedCeiling(deps.exec, BOX_CEILING_META_KEY);
          }
          if (pendingExceptionCeiling !== null) {
            await clearPersistedCeiling(deps.exec, EXCEPTION_CEILING_META_KEY);
          }
          pendingCeiling = null;
          pendingBoxCeiling = null;
          pendingExceptionCeiling = null;
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
