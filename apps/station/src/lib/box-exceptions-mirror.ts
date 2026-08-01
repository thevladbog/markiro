import type { SqlExecutor } from "./mirror.js";

/** One queued exception fact, shaped as the server's sync ingest expects it. */
export interface ExceptionInput {
  kind: "undo" | "clear" | "disassemble" | "reprint";
  boxId: string;
  /** Only set for "undo" -- the single code it targets. */
  codeHash: string | null;
  /** Only set for "undo" -- the original accepted scan timestamp. */
  targetScannedAt: string | null;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  /** Required for everything except "undo" -- see the design spec, scope decision 5. */
  reason: string | null;
  at: string;
}

export interface PendingException extends ExceptionInput {
  id: number;
}

interface ExceptionRow {
  id: number;
  kind: string;
  box_id: string;
  code_hash: string | null;
  target_scanned_at: string | null;
  shift_id: string;
  terminal_id: string | null;
  operator_id: string | null;
  reason: string | null;
  at: string;
}

/** Queues one exception fact for the sync engine to drain (Task 12). */
export async function insertException(exec: SqlExecutor, e: ExceptionInput): Promise<void> {
  await exec.run(
    `INSERT INTO box_exceptions_mirror
       (kind, box_id, code_hash, target_scanned_at, shift_id, terminal_id, operator_id, reason, at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      e.kind,
      e.boxId,
      e.codeHash,
      e.targetScannedAt,
      e.shiftId,
      e.terminalId,
      e.operatorId,
      e.reason,
      e.at,
    ],
  );
}

/**
 * The oldest `limit` queued exceptions, in insertion order -- the same shape
 * as `outbox.ts`'s `readBatch`, including its `ceilingId` retry-safety
 * contract (see that function's doc comment for the full reasoning): a
 * retry re-reads the EXACT row range a still-unacknowledged batch already
 * chose, instead of a fresh `ORDER BY id LIMIT` read that could grow to
 * include exceptions queued since.
 *
 * Unlike `boxes_mirror`'s closure channel, no `acked_at` flag or content
 * signature is needed here: an exception row is a pure fact, written once by
 * `insertException` and never updated in place afterward, so a plain
 * monotonic id ceiling is enough to make a retry stable.
 */
export async function readExceptions(
  exec: SqlExecutor,
  limit: number,
  ceilingId?: number | null,
): Promise<PendingException[]> {
  const rows =
    ceilingId != null
      ? await exec.all<ExceptionRow>(
          `SELECT id, kind, box_id, code_hash, target_scanned_at, shift_id, terminal_id, operator_id, reason, at
             FROM box_exceptions_mirror WHERE id <= ? ORDER BY id LIMIT ?`,
          [ceilingId, limit],
        )
      : await exec.all<ExceptionRow>(
          `SELECT id, kind, box_id, code_hash, target_scanned_at, shift_id, terminal_id, operator_id, reason, at
             FROM box_exceptions_mirror ORDER BY id LIMIT ?`,
          [limit],
        );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as ExceptionInput["kind"],
    boxId: r.box_id,
    codeHash: r.code_hash,
    targetScannedAt: r.target_scanned_at,
    shiftId: r.shift_id,
    terminalId: r.terminal_id,
    operatorId: r.operator_id,
    reason: r.reason,
    at: r.at,
  }));
}

/**
 * Drops everything up to and including `id` -- one statement, which is the
 * only atomic unit available on the device (see `outbox.ts`'s `ackThrough`
 * doc comment on why: `tauri-plugin-sql`'s connection pool cannot guarantee
 * a multi-statement transaction lands on one connection). Called only after
 * the server has confirmed the batch, so a crash before it simply resends.
 */
export async function ackExceptionsThrough(exec: SqlExecutor, id: number): Promise<void> {
  await exec.run("DELETE FROM box_exceptions_mirror WHERE id <= ?", [id]);
}

export async function exceptionDepth(exec: SqlExecutor): Promise<number> {
  const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM box_exceptions_mirror");
  return rows[0]?.n ?? 0;
}

export async function oldestExceptionAt(exec: SqlExecutor): Promise<string | null> {
  const rows = await exec.all<{ at: string }>(
    "SELECT at FROM box_exceptions_mirror ORDER BY id LIMIT 1",
  );
  return rows[0]?.at ?? null;
}
