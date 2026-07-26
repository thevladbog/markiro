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
 * Writes one scan: always an event, plus the code itself when accepted —
 * in a single transaction, so a failed code insert cannot leave a phantom
 * "accepted" event behind. Safe without extra locking because the scan
 * queue guarantees one scan is in flight at a time.
 */
export async function recordScan(
  exec: SqlExecutor,
  e: ScanEventRow,
  code: AcceptedCode | null,
): Promise<void> {
  await exec.run("BEGIN");
  try {
    await appendScanEvent(exec, e);
    if (code) {
      await exec.run(
        `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at)
         VALUES (?,?,?,?,?)`,
        [code.codeHash, code.shiftId, code.gtin14, code.serial, code.scannedAt],
      );
    }
    await exec.run("COMMIT");
  } catch (err) {
    await exec.run("ROLLBACK");
    throw err;
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
