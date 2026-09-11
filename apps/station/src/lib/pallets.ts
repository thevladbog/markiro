import type { SqlExecutor } from "./mirror.js";

/**
 * A pallet on this device, as tracked by `pallets_mirror` -- the same shape
 * as `boxes.ts`'s `DeviceBox` one level up.
 *
 * `boxCount` is derived by counting `boxes_mirror` rows that name this pallet
 * (its `pallet_id` column, written by `joinPallet`), never stored -- for the
 * same reason a box's own item count is derived: a stored counter and the
 * rows it claims to describe drift apart the first time anything goes wrong,
 * and the rows are the truth.
 */
export interface DevicePallet {
  palletId: string;
  shiftId: string;
  terminalId: string | null;
  openedAt: string;
  boxCount: number;
}

export interface UnresolvedPalletPrint {
  palletId: string;
  sscc: string;
  boxCount: number;
  /**
   * The pallet's OWN closure timestamp, read back off `pallets_mirror` --
   * not "now". Mirrors `UnresolvedBoxPrint.closedAt`'s reasoning in
   * `boxes.ts`: a recovery print issued later must still stamp the pallet's
   * original closure time, not the moment it happens to be reprinted.
   *
   * Non-null by construction: `findUnresolvedPalletPrint` only ever returns
   * rows with `closed_at IS NOT NULL`.
   */
  closedAt: string;
  state: "pending" | "printed";
  errorCode: string | null;
}

/**
 * The shift's open pallet (`closed_at IS NULL`), or null if none is open,
 * with a LIVE box count.
 *
 * The count is derived, never stored, for the same reason a box's item count
 * is (see `DevicePallet`'s doc comment): a stored counter and the rows it
 * claims to describe drift apart the first time anything goes wrong, and the
 * rows are the truth.
 *
 * A disassembled box does not count: it is physically off the stack, and
 * counting it would close the pallet one box short of full.
 */
export async function currentPallet(
  exec: SqlExecutor,
  shiftId: string,
): Promise<DevicePallet | null> {
  const rows = await exec.all<{
    pallet_id: string;
    shift_id: string;
    terminal_id: string | null;
    opened_at: string;
    box_count: number;
  }>(
    `SELECT p.pallet_id AS pallet_id, p.shift_id AS shift_id, p.terminal_id AS terminal_id,
            p.opened_at AS opened_at,
            (SELECT COUNT(*) FROM boxes_mirror b
              WHERE b.pallet_id = p.pallet_id AND b.disassembled_at IS NULL) AS box_count
       FROM pallets_mirror p
      WHERE p.shift_id = ? AND p.closed_at IS NULL
      ORDER BY p.opened_at ASC
      LIMIT 1`,
    [shiftId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    palletId: row.pallet_id,
    shiftId: row.shift_id,
    terminalId: row.terminal_id,
    openedAt: row.opened_at,
    boxCount: Number(row.box_count),
  };
}

/**
 * Opens a new pallet for this shift. One INSERT; every other column defaults
 * to null (or, for `print_state`, its `'pending'` default -- this table has
 * no pre-recovery history the way `boxes_mirror`'s `'legacy'` default
 * exists for).
 *
 * Unlike `openBox`, the caller does not supply the id: this is the one
 * identity a pallet gets, generated here and returned so the caller can join
 * boxes to it and close it later.
 */
export async function openPallet(
  exec: SqlExecutor,
  shiftId: string,
  terminalId: string | null,
  openedAt: string,
): Promise<string> {
  const palletId = crypto.randomUUID();
  await exec.run(
    `INSERT INTO pallets_mirror (pallet_id, shift_id, terminal_id, opened_at) VALUES (?,?,?,?)`,
    [palletId, shiftId, terminalId, openedAt],
  );
  return palletId;
}

/** Names a closed box onto this pallet -- a plain pointer update, one column. */
export async function joinPallet(
  exec: SqlExecutor,
  boxId: string,
  palletId: string,
): Promise<void> {
  await exec.run(`UPDATE boxes_mirror SET pallet_id = ? WHERE box_id = ?`, [palletId, boxId]);
}

/**
 * Closes a pallet once its SSCC has been assigned. The same UPDATE records
 * the local pending label, so a crash cannot persist the close without
 * recovery -- and guards on `closed_at IS NULL` so a double close can never
 * rewrite an already-assigned SSCC: a serial that has already reached a
 * printed label and is then overwritten is unrecoverable.
 */
export async function closePallet(
  exec: SqlExecutor,
  palletId: string,
  sscc: string,
  closedAt: string,
  operatorId: string | null,
): Promise<void> {
  await exec.run(
    `UPDATE pallets_mirror
        SET sscc = ?, closed_at = ?, closed_by = ?,
            print_state = 'pending', print_error_code = NULL
      WHERE pallet_id = ? AND closed_at IS NULL`,
    [sscc, closedAt, operatorId, palletId],
  );
}

/** Records successful output for this already-numbered pallet. */
export async function markPalletPrinted(exec: SqlExecutor, palletId: string): Promise<void> {
  await exec.run(
    `UPDATE pallets_mirror
        SET print_state = 'printed', print_error_code = NULL
      WHERE pallet_id = ? AND print_state = 'pending'`,
    [palletId],
  );
}

/** Records an actionable category without persisting a native printer error. */
export async function markPalletPrintFailed(
  exec: SqlExecutor,
  palletId: string,
  code: string,
): Promise<void> {
  await exec.run(
    `UPDATE pallets_mirror
        SET print_state = 'pending', print_error_code = ?
      WHERE pallet_id = ? AND print_state = 'pending'`,
    [code, palletId],
  );
}

export interface ReasonedPalletActionInput {
  palletId: string;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  reason: string;
  occurredAt: string;
}

/**
 * Queues one pallet exception fact for the sync engine to drain, the pallet
 * equivalent of `box-exceptions-mirror.ts`'s `insertException`. Unlike that
 * table, `pallet_exceptions_mirror` has no `AFTER INSERT` trigger applying a
 * local side effect (there is only one local side effect here -- see
 * `disassemblePallet` -- and it does not apply to every kind), so callers
 * that need one apply it themselves, in the same function, right after this
 * insert.
 */
async function insertPalletException(
  exec: SqlExecutor,
  kind: "disassemble" | "reprint",
  input: ReasonedPalletActionInput,
): Promise<void> {
  await exec.run(
    `INSERT INTO pallet_exceptions_mirror
       (kind, pallet_id, shift_id, terminal_id, operator_id, reason, occurred_at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      kind,
      input.palletId,
      input.shiftId,
      input.terminalId,
      input.operatorId,
      input.reason,
      input.occurredAt,
    ],
  );
}

/**
 * Retires a pallet: queues the exception fact and marks the mirror row
 * disassembled, so it drops out of print recovery and can never be
 * reprinted or disassembled again through this path. The server
 * independently voids the pallet's SSCC forever, the same way it does for a
 * disassembled box (see `boxes.ts`'s `disassembleBox` doc comment) -- a
 * re-palletized stack is a brand-new pallet row with a brand-new SSCC.
 */
export async function disassemblePallet(
  exec: SqlExecutor,
  input: ReasonedPalletActionInput,
): Promise<void> {
  await insertPalletException(exec, "disassemble", input);
  await exec.run(`UPDATE pallets_mirror SET disassembled_at = ? WHERE pallet_id = ?`, [
    input.occurredAt,
    input.palletId,
  ]);
}

/** Queues an unchanged label reprint for a closed pallet. */
export async function reprintPallet(
  exec: SqlExecutor,
  input: ReasonedPalletActionInput,
): Promise<void> {
  await insertPalletException(exec, "reprint", input);
}

/**
 * Returns the oldest unresolved label for this shift, or null if none is
 * pending -- the pallet equivalent of `boxes.ts`'s `findUnresolvedBoxPrint`.
 */
export async function findUnresolvedPalletPrint(
  exec: SqlExecutor,
  shiftId: string,
): Promise<UnresolvedPalletPrint | null> {
  const rows = await exec.all<{
    pallet_id: string;
    sscc: string;
    box_count: number;
    closed_at: string;
    print_state: "pending" | "printed";
    print_error_code: string | null;
  }>(
    `SELECT p.pallet_id AS pallet_id, p.sscc AS sscc,
            (SELECT COUNT(*) FROM boxes_mirror b
              WHERE b.pallet_id = p.pallet_id AND b.disassembled_at IS NULL) AS box_count,
            p.closed_at AS closed_at,
            p.print_state AS print_state, p.print_error_code AS print_error_code
       FROM pallets_mirror p
      WHERE p.shift_id = ?
        AND p.closed_at IS NOT NULL AND p.sscc IS NOT NULL
        AND p.disassembled_at IS NULL
        AND p.print_state = 'pending'
      ORDER BY p.closed_at ASC, p.pallet_id ASC
      LIMIT 1`,
    [shiftId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    palletId: row.pallet_id,
    sscc: row.sscc,
    boxCount: Number(row.box_count),
    closedAt: row.closed_at,
    state: row.print_state,
    errorCode: row.print_error_code,
  };
}
