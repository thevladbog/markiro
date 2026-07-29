import type { SqlExecutor } from "./mirror.js";

/** One queued scan, shaped as the server's ingest endpoint expects it. */
export interface OutboxItem {
  id: number;
  shiftId: string;
  terminalId: string | null;
  raw: string;
  verdict: string;
  scannedAt: string;
  /** Present only for a scan this device accepted and stored. */
  code: { codeHash: string; gtin14: string; serial: string } | null;
}

interface OutboxRow {
  id: number;
  shift_id: string;
  terminal_id: string | null;
  raw: string;
  verdict: string;
  scanned_at: string;
  code_hash: string | null;
  gtin14: string | null;
  serial: string | null;
}

/**
 * The oldest `limit` queued scans, in insertion order. Order matters: the
 * acknowledgement deletes a contiguous range by id, so a batch must always be
 * a prefix of the queue.
 *
 * `ceilingId`, when given, additionally requires `id <= ceilingId`. This is
 * how a retry (whether the engine's own scheduled backoff attempt or a
 * nudge that lands while one is outstanding) re-reads the EXACT row range a
 * still-unacknowledged batch already chose, instead of a fresh
 * `ORDER BY id LIMIT` read that could have grown to include rows enqueued
 * since — see `sync.ts`'s `pendingCeiling` and its doc comment for why that
 * growth is exactly what let a resend duplicate data server-side. Omitted
 * (or `null`), this is a plain "first `limit` rows" read, used only when no
 * batch is currently in flight.
 */
export async function readBatch(
  exec: SqlExecutor,
  limit: number,
  ceilingId?: number | null,
): Promise<OutboxItem[]> {
  const rows =
    ceilingId != null
      ? await exec.all<OutboxRow>(
          `SELECT id, shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial
             FROM outbox WHERE id <= ? ORDER BY id LIMIT ?`,
          [ceilingId, limit],
        )
      : await exec.all<OutboxRow>(
          `SELECT id, shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial
             FROM outbox ORDER BY id LIMIT ?`,
          [limit],
        );
  return rows.map((r) => ({
    id: r.id,
    shiftId: r.shift_id,
    terminalId: r.terminal_id,
    raw: r.raw,
    verdict: r.verdict,
    scannedAt: r.scanned_at,
    code:
      r.code_hash !== null && r.gtin14 !== null && r.serial !== null
        ? { codeHash: r.code_hash, gtin14: r.gtin14, serial: r.serial }
        : null,
  }));
}

/**
 * Drops everything up to and including `id` — one statement, which is the
 * only atomic unit available on the device (see journal.ts on the
 * `tauri-plugin-sql` connection pool). Called only after the server has
 * confirmed the batch, so a crash before it simply resends.
 */
export async function ackThrough(exec: SqlExecutor, id: number): Promise<void> {
  await exec.run("DELETE FROM outbox WHERE id <= ?", [id]);
}

export async function outboxDepth(exec: SqlExecutor): Promise<number> {
  const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
  return rows[0]?.n ?? 0;
}

/** When the oldest still-queued scan happened, or null on an empty queue. */
export async function oldestQueuedAt(exec: SqlExecutor): Promise<string | null> {
  const rows = await exec.all<{ scanned_at: string }>(
    "SELECT scanned_at FROM outbox ORDER BY id LIMIT 1",
  );
  return rows[0]?.scanned_at ?? null;
}
