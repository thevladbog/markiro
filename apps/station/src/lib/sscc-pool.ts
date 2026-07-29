import type { SqlExecutor } from "./mirror.js";

/**
 * A block of SSCC serials the server handed down for this device's own
 * issuer prefix (`StationBundle.sscc` in `mirror.ts`). Keyed by the 9-digit
 * GS1 issuer PREFIX, not a GLN: one GS1 member commonly holds several GLNs
 * that differ only in location digits and share one serial space, so keying
 * by GLN would let one device treat that single space as two independent
 * ones. `extensionDigit` keeps box ranges (0) and pallet ranges (1, slice
 * 06d) from ever mixing.
 */
export interface PoolRange {
  issuerPrefix: string;
  extensionDigit: number;
  fromSerial: number;
  toSerial: number;
  nextSerial: number;
}

/**
 * Adds a range the device received from the server.
 *
 * Idempotent: the primary key on (issuer_prefix, extension_digit,
 * from_serial) drops a block the device already holds, so a replayed sync
 * bundle can never double the pool.
 */
export async function addRange(exec: SqlExecutor, r: Omit<PoolRange, "nextSerial">): Promise<void> {
  await exec.run(
    `INSERT INTO sscc_pool (issuer_prefix, extension_digit, from_serial, to_serial, next_serial)
     VALUES (?,?,?,?,?)
     ON CONFLICT(issuer_prefix, extension_digit, from_serial) DO NOTHING`,
    [r.issuerPrefix, r.extensionDigit, r.fromSerial, r.toSerial, r.fromSerial],
  );
}

/**
 * Consumes the lowest unspent serial for this issuer prefix and extension
 * digit, or null when the pool is dry.
 *
 * ONE statement, deliberately. `tauri-plugin-sql` opens SQLite through a
 * connection pool and hands each call out on whatever connection is free, so
 * a SELECT followed by an UPDATE can give the same serial to two callers --
 * and two boxes sharing one SSCC is the one failure the server cannot
 * repair. The UPDATE ... RETURNING below picks the earliest range that
 * still has room (ORDER BY from_serial) and advances its cursor in the same
 * statement that reads it.
 */
export async function burnSerial(
  exec: SqlExecutor,
  issuerPrefix: string,
  extensionDigit: number,
): Promise<number | null> {
  const rows = await exec.all<{ serial: number }>(
    `UPDATE sscc_pool SET next_serial = next_serial + 1
     WHERE rowid = (
       SELECT rowid FROM sscc_pool
       WHERE issuer_prefix = ? AND extension_digit = ? AND next_serial <= to_serial
       ORDER BY from_serial LIMIT 1
     )
     RETURNING next_serial - 1 AS serial`,
    [issuerPrefix, extensionDigit],
  );
  const row = rows[0];
  return row ? row.serial : null;
}

/** Counts unburned serials left across every range for this prefix/digit. */
export async function remaining(
  exec: SqlExecutor,
  issuerPrefix: string,
  extensionDigit: number,
): Promise<number> {
  const rows = await exec.all<{ n: number }>(
    `SELECT COALESCE(SUM(to_serial - next_serial + 1), 0) AS n FROM sscc_pool
     WHERE issuer_prefix = ? AND extension_digit = ? AND next_serial <= to_serial`,
    [issuerPrefix, extensionDigit],
  );
  return Number(rows[0]?.n ?? 0);
}
