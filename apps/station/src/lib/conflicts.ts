import type { SqlExecutor } from "./mirror.js";

/** A code this device scanned that an earlier scan elsewhere already owns. */
export interface DeviceConflict {
  codeHash: string;
  winningTerminalId: string | null;
  winningScannedAt: string;
  detectedAt: string;
  /** From `codes_mirror`, so a person can find the physical item. */
  gtin14: string | null;
  serial: string | null;
}

/**
 * Records conflicts the server reported for a batch. Keyed by code, so the
 * same conflict arriving twice is one row — one statement per conflict, no
 * device transaction (the connection pool makes multi-call ones unsound).
 */
export async function recordConflicts(
  exec: SqlExecutor,
  rows: { codeHash: string; winningTerminalId: string | null; winningScannedAt: string }[],
  detectedAt: string,
): Promise<void> {
  for (const row of rows) {
    await exec.run(
      `INSERT INTO conflicts_mirror (code_hash, winning_terminal_id, winning_scanned_at, detected_at)
       VALUES (?,?,?,?)
       ON CONFLICT(code_hash) DO NOTHING`,
      [row.codeHash, row.winningTerminalId, row.winningScannedAt, detectedAt],
    );
  }
}

/**
 * Newest first. Left-outer against `codes_mirror` because retention may have
 * purged the code row, and a conflict must still be listable without it.
 */
export async function readConflicts(exec: SqlExecutor): Promise<DeviceConflict[]> {
  const rows = await exec.all<{
    code_hash: string;
    winning_terminal_id: string | null;
    winning_scanned_at: string;
    detected_at: string;
    gtin14: string | null;
    serial: string | null;
  }>(
    `SELECT c.code_hash, c.winning_terminal_id, c.winning_scanned_at, c.detected_at,
            m.gtin14, m.serial
       FROM conflicts_mirror c
       LEFT JOIN codes_mirror m ON m.code_hash = c.code_hash
      ORDER BY c.detected_at DESC`,
  );
  return rows.map((r) => ({
    codeHash: r.code_hash,
    winningTerminalId: r.winning_terminal_id,
    winningScannedAt: r.winning_scanned_at,
    detectedAt: r.detected_at,
    gtin14: r.gtin14,
    serial: r.serial,
  }));
}

export async function conflictCount(exec: SqlExecutor): Promise<number> {
  const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM conflicts_mirror");
  return rows[0]?.n ?? 0;
}
