import type { SqlExecutor } from "./mirror.js";
import { insertException } from "./box-exceptions-mirror.js";

/** One row of the local scan journal — every scan, accepted or not. */
export interface ScanEventRow {
  shiftId: string;
  terminalId: string | null;
  raw: string;
  verdict: string;
  scannedAt: string;
  /**
   * The operator signed in when this scan happened, or null if none.
   * Required rather than optional: unlike a report that can be added later,
   * an attribution never captured here can never be recovered, so every
   * call site must make an explicit choice instead of silently defaulting.
   */
  operatorId: string | null;
}

/** An accepted code, mirrored for offline duplicate detection. */
export interface AcceptedCode {
  codeHash: string;
  shiftId: string;
  gtin14: string;
  serial: string;
  scannedAt: string;
  /**
   * The transport box this code was scanned into, or null if none is open.
   * A plain column on the code row rather than a join table — see
   * `recordScan`'s doc comment below for why a fourth write was rejected in
   * favour of riding the insert already made here.
   */
  boxId: string | null;
}

/** Display-only scan fact. Raw scanner payloads never leave this boundary. */
export interface RecentOperation {
  verdict: string;
  /** Null when a legacy/corrupt row does not contain a parseable timestamp. */
  scannedAt: string | null;
  /** A deliberately short suffix for operator recognition, never the full code. */
  codeSuffix: string | null;
}

const RECENT_OPERATION_LIMIT = 6;

/**
 * The latest bounded scan facts for one shift. Valid timestamps sort newest
 * first, ties are resolved by the mirror's monotonic id, and malformed legacy
 * timestamps remain visible after valid rows without reaching date formatting.
 */
export async function listRecentOperations(
  exec: SqlExecutor,
  shiftId: string,
): Promise<RecentOperation[]> {
  const rows = await exec.all<{
    raw: string;
    verdict: string;
    scanned_at: string;
  }>(
    `SELECT raw, verdict, scanned_at
       FROM scan_events_mirror
      WHERE shift_id = ?
      ORDER BY (julianday(scanned_at) IS NULL) ASC, julianday(scanned_at) DESC, id DESC
      LIMIT ?`,
    [shiftId, RECENT_OPERATION_LIMIT],
  );

  return rows.map((row) => {
    const characters = Array.from(row.raw).filter((character) => /[\p{L}\p{N}]/u.test(character));
    return {
      verdict: row.verdict,
      scannedAt: Number.isNaN(Date.parse(row.scanned_at)) ? null : row.scanned_at,
      codeSuffix: characters.length < 8 ? null : `…${characters.slice(-4).join("")}`,
    };
  });
}

/**
 * Every accepted code key on this device, as a Set for the domain's
 * SYNCHRONOUS `isDuplicate(key)` contract (SQLite itself is async, so the
 * check cannot hit the database at scan time).
 *
 * Device-wide, not shift-scoped, because `codes_mirror.code_hash` is a global
 * primary key and a KM identifies one physical item: the same code scanned
 * under a different shift is still a duplicate. A shift-scoped set would let
 * such a scan pass validation and then fail the insert, losing the journal
 * entry AND the operator's signal.
 */
export async function loadCodeKeys(exec: SqlExecutor): Promise<Set<string>> {
  const rows = await exec.all<{ code_hash: string }>("SELECT code_hash FROM codes_mirror");
  return new Set(rows.map((r) => r.code_hash));
}

export async function appendScanEvent(exec: SqlExecutor, e: ScanEventRow): Promise<void> {
  await exec.run(
    `INSERT INTO scan_events_mirror (shift_id, terminal_id, raw, verdict, scanned_at, operator_id)
     VALUES (?,?,?,?,?,?)`,
    [e.shiftId, e.terminalId, e.raw, e.verdict, e.scannedAt, e.operatorId],
  );
}

/**
 * True for SQLite's "UNIQUE constraint failed" (and the "PRIMARY KEY"
 * phrasing some drivers use for the same conflict) — the signal that
 * `codes_mirror.code_hash` already holds this row, i.e. this exact code was
 * already accepted. Anything else is a genuine write failure and must not be
 * mistaken for a duplicate.
 */
function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unique constraint failed|primary key constraint/i.test(message);
}

/** What actually happened when recording one scan — see {@link recordScan}. */
export interface RecordScanResult {
  /** True when a code row was supplied and newly inserted into `codes_mirror`. */
  storedCode: boolean;
  /**
   * True when a code was supplied but its insert failed because the row
   * already exists — this code was already accepted, on this shift or
   * another. The caller should treat the scan as a duplicate regardless of
   * what the in-memory duplicate index said before the write was attempted.
   */
  alreadyPresent: boolean;
}

/**
 * Writes one scan: the code row FIRST (only when accepted), the event row
 * SECOND.
 *
 * Deliberately NOT wrapped in a transaction — do not reintroduce
 * BEGIN/COMMIT/ROLLBACK here. `tauri-plugin-sql` opens SQLite through sqlx's
 * `Pool::connect` (up to 10 connections, a FIFO idle queue), and hands a
 * possibly DIFFERENT pooled connection to every `exec.run` call. A `BEGIN`
 * sent on one call, the inserts on others, and a `COMMIT` on yet another are
 * therefore not one transaction at all — multi-call transactions over this
 * pool are simply unsound. On a real device, with the settings read racing
 * migrations, the 250 ms shift-context poll overlapping `mirrorShiftBundle`,
 * and `syncOperatorRoster` re-running on every `online` event mid-shift,
 * `COMMIT` can fail with "no transaction is active": the `ROLLBACK` that used
 * to follow would then discard the code row, `recordScan` would throw, and
 * the scan queue's catch-and-log would swallow it — the scan would vanish
 * with no signal to the operator, and the same code could be accepted again
 * later. node:sqlite (a single synchronous connection) cannot reproduce this,
 * which is why the unit tests alone never caught it.
 *
 * Instead this relies on `codes_mirror.code_hash` being the PRIMARY KEY. The
 * code insert runs first because its failure is meaningful: a
 * UNIQUE/PRIMARY KEY constraint violation means this exact code is already
 * accepted — a duplicate — and is reported back as `alreadyPresent` instead
 * of thrown, so the caller can correct its verdict. Any OTHER error from the
 * code insert rethrows: an unknown write failure must never be silently
 * reported as a duplicate.
 *
 * The event row is always attempted afterwards, even when the code turned
 * out to already be present — the audit trail in `scan_events_mirror` is
 * what makes a duplicate diagnosable later. Its `verdict` reflects what
 * actually happened, not what the caller predicted: if the code insert hit
 * `alreadyPresent`, the row is journalled as `"duplicate"` regardless of the
 * verdict the caller passed in, so the mirror never claims a scan was
 * accepted when the operator was shown a duplicate. If that insert fails, it
 * throws: a code row without its audit row is strictly better than a lost
 * code.
 *
 * The event write and the outbox insert that follows it are each
 * compensated the same way on failure, rather than left to stand: if THIS
 * call is the one that just stored a new code row (`storedCode`), that row
 * is best-effort deleted from `codes_mirror` before the original error is
 * rethrown. Throwing alone does not make the scan recoverable —
 * `codes_mirror.code_hash` is already committed by the time either later
 * write can fail, so without the compensating delete the operator's rescan
 * of the same physical item hits the primary key, is reported as
 * `alreadyPresent`, and is journalled (and, for the outbox case, would-be
 * enqueued) as `"duplicate"` with no code payload, because that payload is
 * gated on `storedCode`. The accepted code would then never reach the server
 * and never could: the one path in this slice that loses data instead of
 * duplicating it. This is exactly as true when `appendScanEvent` itself
 * throws as when the outbox insert does — the code row was already
 * committed either way — so both call sites share `compensateStoredCode`
 * below rather than each growing their own copy of this logic and risking
 * the two drifting apart. Deleting the just-stored row turns the rescan into
 * a clean accept instead. The compensating delete is itself best-effort: if
 * it also fails, that secondary error is swallowed and the ORIGINAL error is
 * rethrown regardless, because that is what tells the operator to rescan,
 * and a failed cleanup leaves us no worse off than before this fix. Nothing
 * is deleted when `storedCode` is false — a scan that was already a
 * duplicate, or one with no code at all, has nothing of its own to undo, and
 * deleting then would erase a code an earlier scan legitimately stored. The
 * `scan_events_mirror` row is never touched by this compensation: it is the
 * audit trail and it honestly records that an attempt happened.
 */
async function compensateStoredCode(
  exec: SqlExecutor,
  storedCode: boolean,
  code: AcceptedCode | null,
): Promise<void> {
  if (!(storedCode && code)) return;
  try {
    await exec.run("DELETE FROM codes_mirror WHERE code_hash = ?", [code.codeHash]);
  } catch {
    // Best-effort: the caller's original error is what must reach the
    // operator, and a failed cleanup leaves us no worse off than before this
    // fix — the next sync attempt still has nothing new to send for this row.
  }
}
export async function recordScan(
  exec: SqlExecutor,
  e: ScanEventRow,
  code: AcceptedCode | null,
): Promise<RecordScanResult> {
  let storedCode = false;
  let alreadyPresent = false;

  if (code) {
    try {
      await exec.run(
        `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id)
         VALUES (?,?,?,?,?,?)`,
        [code.codeHash, code.shiftId, code.gtin14, code.serial, code.scannedAt, code.boxId],
      );
      storedCode = true;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      alreadyPresent = true;
    }
  }

  const journalled = alreadyPresent ? { ...e, verdict: "duplicate" } : e;
  // A failure here is exactly as dangerous as an outbox failure below: the
  // code row (if any) is already committed, so it must be compensated away
  // the same way before rethrowing. See the doc comment above (Finding 3).
  try {
    await appendScanEvent(exec, journalled);
  } catch (eventErr) {
    await compensateStoredCode(exec, storedCode, code);
    throw eventErr;
  }

  // Enqueued LAST. The verdict is not final until the code insert has either
  // succeeded or hit the primary key, so an earlier enqueue could queue "ok"
  // for a scan the operator was shown as a duplicate. A failure here still
  // rethrows — it must reach the operator through the scan queue's error path
  // rather than vanishing quietly — but first, if THIS call stored a new code
  // row, that row is compensated away so the rescan the operator is about to
  // do lands as a fresh accept instead of a phantom duplicate. See the doc
  // comment above for the full story.
  try {
    await exec.run(
      `INSERT INTO outbox (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial, box_id, operator_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        journalled.shiftId,
        journalled.terminalId,
        journalled.raw,
        journalled.verdict,
        journalled.scannedAt,
        storedCode && code ? code.codeHash : null,
        storedCode && code ? code.gtin14 : null,
        storedCode && code ? code.serial : null,
        storedCode && code ? code.boxId : null,
        journalled.operatorId,
      ],
    );
  } catch (outboxErr) {
    await compensateStoredCode(exec, storedCode, code);
    throw outboxErr;
  }

  return { storedCode, alreadyPresent };
}

/** Input to {@link undoLastScan}. */
export interface UndoScanInput {
  boxId: string;
  codeHash: string;
  scannedAt: string;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  at: string;
}

/**
 * Undoes the single most recent scan into a still-open box: frees the code
 * hash immediately (so a rescan is never mistaken for a duplicate),
 * journals the correction, and queues the fact for the server to release
 * the same code from `code_registry` (see the design spec's "Releasing a
 * code" section).
 *
 * The durable exception is queued first. The local cleanup that follows is
 * idempotent, while deleting locally first could permanently lose the only
 * fact that tells the server to release ownership if a later write failed.
 */
export async function undoLastScan(exec: SqlExecutor, input: UndoScanInput): Promise<void> {
  await insertException(exec, {
    kind: "undo",
    boxId: input.boxId,
    codeHash: input.codeHash,
    targetScannedAt: input.scannedAt,
    shiftId: input.shiftId,
    terminalId: input.terminalId,
    operatorId: input.operatorId,
    reason: null,
    at: input.at,
  });
  // The trigger installed with box_exceptions_mirror deletes the code in the
  // same statement as the INSERT above. This secondary local journal entry
  // must not turn an already-completed correction into a reported failure.
  try {
    await appendScanEvent(exec, {
      shiftId: input.shiftId,
      terminalId: input.terminalId,
      raw: input.codeHash,
      verdict: "undone",
      scannedAt: input.at,
      operatorId: input.operatorId,
    });
  } catch (err) {
    console.error("station: failed to append undo scan event", err);
  }
}

/** When this code was originally accepted, for the duplicate signal. */
export async function findFirstSeen(exec: SqlExecutor, codeHash: string): Promise<string | null> {
  const rows = await exec.all<{ scanned_at: string }>(
    "SELECT scanned_at FROM codes_mirror WHERE code_hash = ?",
    [codeHash],
  );
  return rows[0]?.scanned_at ?? null;
}
