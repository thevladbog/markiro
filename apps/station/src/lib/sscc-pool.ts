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
 * A range as the server now describes it (final review, finding 1):
 * `fromSerial`/`toSerial` are always the block's ORIGINAL bounds, even for
 * a block the device already holds, and `consumedThroughSerial` -- the
 * highest serial the server has recorded as actually used, or null before
 * any is -- is what lets `addRange` reconcile its own cursor against the
 * row it already has instead of treating the block as a brand new range.
 * Optional so every existing caller that only ever hands a genuinely fresh
 * range (nothing consumed yet) is unaffected.
 */
export type ServerRange = Omit<PoolRange, "nextSerial"> & {
  consumedThroughSerial?: number | null;
};

/**
 * Adds a range the device received from the server.
 *
 * Idempotent, and progress-preserving: the primary key on (issuer_prefix,
 * extension_digit, from_serial) turns a replay of a block the device
 * already holds into an UPDATE of that SAME row rather than a second one,
 * and `next_serial = MAX(...)` makes the update safe in both directions --
 * it never regresses an already-advanced local cursor, and it advances a
 * cursor that is somehow behind what the server knows was consumed (e.g.
 * this device's local database was lost or restored from a stale
 * snapshot: re-provisioning, or resuming from an old copy that still holds
 * this row, would otherwise let `burnSerial` reissue serials already on
 * printed labels).
 *
 * This used to be `ON CONFLICT ... DO NOTHING` (final review, finding 1).
 * That was safe only as long as the server always sent back either a
 * genuinely fresh range or a byte-for-byte replay of one already held --
 * it stopped being safe the moment a repeat bundle fetch could describe an
 * existing block with a DIFFERENT `fromSerial` (the old
 * `allocateForBundle` shrank it to the unconsumed remainder): that shape
 * never matches the existing row's primary key, so it inserted as a
 * SECOND, overlapping row instead of conflicting with the first, and
 * `burnSerial`'s `ORDER BY from_serial` would drain the original row's
 * remainder, then restart the second row from ITS OWN `from_serial` --
 * reissuing every serial in between. The server now always reports a
 * block's ORIGINAL bounds (see `SsccService.allocateForBundle`), so this
 * INSERT always targets the row the device already has; `next_serial`'s
 * candidate value below is what actually reconciles the cursor.
 */
export async function addRange(exec: SqlExecutor, r: ServerRange): Promise<void> {
  const consumedCursor =
    r.consumedThroughSerial != null ? r.consumedThroughSerial + 1 : r.fromSerial;
  const boxMinimum = r.extensionDigit === 0 ? 1 : r.fromSerial;
  const nextSerial = Math.max(consumedCursor, boxMinimum);
  await exec.run(
    `INSERT INTO sscc_pool (issuer_prefix, extension_digit, from_serial, to_serial, next_serial)
     VALUES (?,?,?,?,?)
     ON CONFLICT(issuer_prefix, extension_digit, from_serial)
     DO UPDATE SET next_serial = MAX(next_serial, excluded.next_serial)`,
    [r.issuerPrefix, r.extensionDigit, r.fromSerial, r.toSerial, nextSerial],
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
