import type { SqlExecutor } from "./mirror.js";

/** One row of the local scan journal — every scan, accepted or not. */
export interface ScanEventRow {
  shiftId: string;
  terminalId: string | null;
  raw: string;
  verdict: string;
  scannedAt: string;
}

/** An accepted code, mirrored for offline duplicate detection. */
export interface AcceptedCode {
  codeHash: string;
  shiftId: string;
  gtin14: string;
  serial: string;
  scannedAt: string;
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
    `INSERT INTO scan_events_mirror (shift_id, terminal_id, raw, verdict, scanned_at)
     VALUES (?,?,?,?,?)`,
    [e.shiftId, e.terminalId, e.raw, e.verdict, e.scannedAt],
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
 */
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
        `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at)
         VALUES (?,?,?,?,?)`,
        [code.codeHash, code.shiftId, code.gtin14, code.serial, code.scannedAt],
      );
      storedCode = true;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      alreadyPresent = true;
    }
  }

  await appendScanEvent(exec, alreadyPresent ? { ...e, verdict: "duplicate" } : e);

  return { storedCode, alreadyPresent };
}

/** When this code was originally accepted, for the duplicate signal. */
export async function findFirstSeen(exec: SqlExecutor, codeHash: string): Promise<string | null> {
  const rows = await exec.all<{ scanned_at: string }>(
    "SELECT scanned_at FROM codes_mirror WHERE code_hash = ?",
    [codeHash],
  );
  return rows[0]?.scanned_at ?? null;
}
