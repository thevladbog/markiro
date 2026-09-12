import type { BoxPrintErrorCode } from "./boxes.js";
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
  /**
   * Always `"pending"`: unlike `UnresolvedBoxPrint`, a pallet has no
   * scan-back verification path that could surface a `"printed"` row here.
   * `findUnresolvedPalletPrint`'s query filters on `print_state = 'pending'`
   * unconditionally, so this field can never actually be anything else
   * (Task 15 review, Finding 5).
   */
  state: "pending";
  errorCode: BoxPrintErrorCode | null;
}

/**
 * The shift AND TERMINAL's open pallet (`closed_at IS NULL`), or null if none
 * is open, with a LIVE box count.
 *
 * Scoped by `terminal_id` as well as `shift_id` -- the 06d spec's ownership
 * model is "One terminal. Two terminals in one shift build two pallets": an
 * unscoped query would hand two stations working the same shift the SAME
 * open pallet and have them fight over it. Uses `IS` rather than `=` so a
 * device with no terminal id (`terminalId: null`) still matches only its own
 * kind of pallet row, the same way `findUnresolvedPalletPrint` already
 * compares this column.
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
  terminalId: string | null,
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
      WHERE p.shift_id = ? AND p.terminal_id IS ? AND p.closed_at IS NULL
      ORDER BY p.opened_at ASC
      LIMIT 1`,
    [shiftId, terminalId],
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
 *
 * Returns whether THIS call performed the close (the `markPrintVerified`/
 * `markPrintSkipped` precedent in `boxes.ts`), not void: the guard above can
 * legitimately no-op on a genuine double close, and a caller that trusted an
 * unpersisted serial in that case could hand a label a serial the database
 * never stored.
 */
export async function closePallet(
  exec: SqlExecutor,
  palletId: string,
  sscc: string,
  closedAt: string,
  operatorId: string | null,
): Promise<boolean> {
  const rows = await exec.all<{ pallet_id: string }>(
    `UPDATE pallets_mirror
        SET sscc = ?, closed_at = ?, closed_by = ?,
            print_state = 'pending', print_error_code = NULL
      WHERE pallet_id = ? AND closed_at IS NULL
      RETURNING pallet_id`,
    [sscc, closedAt, operatorId, palletId],
  );
  return rows.length === 1;
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
  code: BoxPrintErrorCode,
): Promise<void> {
  await exec.run(
    `UPDATE pallets_mirror
        SET print_state = 'pending', print_error_code = ?
      WHERE pallet_id = ? AND print_state = 'pending'`,
    [code, palletId],
  );
}

/**
 * Records that the operator confirmed a pallet label they could not have the
 * device verify automatically -- the "unknown" print outcome shown when this
 * device restarts mid-print and cannot tell whether the label reached the
 * printer. Mirrors `boxes.ts`'s `markPrintVerified` exactly, including
 * clearing `acked_at` on the SAME row (Task 13 review, Finding 1, restated in
 * this task's brief): the sync engine's pallet-closure query is gated on
 * `acked_at IS NULL`, and a closure this old has typically already been
 * acknowledged by the time the operator resolves this prompt. Without
 * re-clearing it here, this outcome would have no way off the device -- the
 * closure was already acked and would never be read again. Clearing it
 * un-gates exactly one more resend of THIS pallet's closure, now carrying the
 * resolved outcome.
 */
export async function markPalletPrintVerified(
  exec: SqlExecutor,
  palletId: string,
  at: string,
): Promise<boolean> {
  const rows = await exec.all<{ pallet_id: string }>(
    `UPDATE pallets_mirror
        SET print_state = 'printed', print_error_code = NULL,
            print_verified_at = ?, acked_at = NULL
      WHERE pallet_id = ? AND print_state IN ('pending', 'printed')
        AND print_verified_at IS NULL AND print_skipped_at IS NULL
      RETURNING pallet_id`,
    [at, palletId],
  );
  return rows.length === 1;
}

/**
 * Records that the operator explicitly chose NOT to print (or reprint) a
 * closed pallet's label -- the pallet equivalent of `boxes.ts`'s
 * `markPrintSkipped`. Clears `acked_at` for the same reason
 * `markPalletPrintVerified` above does.
 */
export async function markPalletPrintSkipped(
  exec: SqlExecutor,
  palletId: string,
  at: string,
): Promise<boolean> {
  const rows = await exec.all<{ pallet_id: string }>(
    `UPDATE pallets_mirror
        SET print_state = 'skipped', print_error_code = NULL,
            print_skipped_at = ?, acked_at = NULL
      WHERE pallet_id = ? AND print_state IN ('pending', 'printed')
        AND print_verified_at IS NULL AND print_skipped_at IS NULL
      RETURNING pallet_id`,
    [at, palletId],
  );
  return rows.length === 1;
}

/**
 * Units across every box this pallet still carries (a disassembled box no
 * longer counts, the same exclusion `currentPallet`'s own `boxCount` and
 * `boxes.ts`'s `DeviceBox.itemCount` already apply). Queried on demand,
 * rather than carried on `ClosePalletResult`/`UnresolvedPalletPrint`,
 * because it is needed in exactly one place -- composing this pallet's
 * label fields (`palletLabelFields`'s `qty`) -- and every other caller of
 * those two shapes has no use for it.
 */
export async function palletItemCount(exec: SqlExecutor, palletId: string): Promise<number> {
  const rows = await exec.all<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM codes_mirror c
       JOIN boxes_mirror b ON b.box_id = c.box_id
      WHERE b.pallet_id = ? AND b.disassembled_at IS NULL`,
    [palletId],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface ClosedPalletSummary {
  palletId: string;
  sscc: string;
  boxCount: number;
  closedAt: string;
}

/**
 * Closed, not-yet-disassembled pallets for this shift and terminal, most
 * recently closed first -- the pallet equivalent of `boxes.ts`'s
 * `listClosedBoxes`, the picker for the reprint/disassemble panel.
 */
export async function listClosedPallets(
  exec: SqlExecutor,
  shiftId: string,
  terminalId: string | null,
): Promise<ClosedPalletSummary[]> {
  const rows = await exec.all<{
    pallet_id: string;
    sscc: string;
    closed_at: string;
    box_count: number;
  }>(
    `SELECT p.pallet_id AS pallet_id, p.sscc AS sscc, p.closed_at AS closed_at,
            (SELECT COUNT(*) FROM boxes_mirror b
              WHERE b.pallet_id = p.pallet_id AND b.disassembled_at IS NULL) AS box_count
       FROM pallets_mirror p
      WHERE p.shift_id = ? AND p.terminal_id IS ?
        AND p.closed_at IS NOT NULL AND p.disassembled_at IS NULL
      ORDER BY p.closed_at DESC`,
    [shiftId, terminalId],
  );
  return rows.map((r) => ({
    palletId: r.pallet_id,
    sscc: r.sscc,
    boxCount: Number(r.box_count),
    closedAt: r.closed_at,
  }));
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
 * The server rejects an exception `reason` over 500 characters with a 400 --
 * and the sync drain retries a rejected batch forever, since a 400 is not
 * one of the transient failures it backs off from. Clamped here, at the one
 * place every pallet exception fact is written, so no caller (the operator's
 * free-text "other reason" box, a future one) can queue a fact the server
 * will refuse and the device can never work off.
 */
const MAX_REASON_LENGTH = 500;

/**
 * Queues one pallet exception fact for the sync engine to drain, the pallet
 * equivalent of `box-exceptions-mirror.ts`'s `insertException`. For a
 * `disassemble` fact, the `pallet_exception_disassemble_local` AFTER INSERT
 * trigger (`packages/db/src/sqlite/migrations.ts`) applies the matching
 * local side effect in the SAME statement -- mirroring
 * `box_exception_disassemble_local` -- so callers never need a second write
 * to keep the two in sync.
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
      input.reason.slice(0, MAX_REASON_LENGTH),
      input.occurredAt,
    ],
  );
}

/**
 * Retires a pallet: queues the exception fact, which the
 * `pallet_exception_disassemble_local` trigger atomically pairs with marking
 * the mirror row disassembled in the same INSERT (see `insertPalletException`
 * above), so it drops out of print recovery and can never be reprinted or
 * disassembled again through this path. The server independently voids the
 * pallet's SSCC forever, the same way it does for a disassembled box (see
 * `boxes.ts`'s `disassembleBox` doc comment) -- a re-palletized stack is a
 * brand-new pallet row with a brand-new SSCC.
 */
export async function disassemblePallet(
  exec: SqlExecutor,
  input: ReasonedPalletActionInput,
): Promise<void> {
  await insertPalletException(exec, "disassemble", input);
}

/** Queues an unchanged label reprint for a closed pallet. */
export async function reprintPallet(
  exec: SqlExecutor,
  input: ReasonedPalletActionInput,
): Promise<void> {
  await insertPalletException(exec, "reprint", input);
}

/** One queued pallet exception fact, shaped as the server's sync ingest expects it. */
export interface PendingPalletException extends ReasonedPalletActionInput {
  id: number;
  kind: "disassemble" | "reprint";
}

/**
 * The oldest `limit` queued pallet exceptions, in insertion order -- the exact
 * counterpart of `box-exceptions-mirror.ts`'s `readExceptions`, including its
 * `ceilingId` retry-safety contract: a retry re-reads the EXACT row range a
 * still-unacknowledged batch already chose, instead of a fresh
 * `ORDER BY id LIMIT` read that could grow to include facts queued since.
 *
 * No `acked_at` flag or content signature is needed, for the same reason the
 * box channel needs none: a pallet exception row is a pure fact, written once
 * by `insertPalletException` and never updated in place afterward, so a plain
 * monotonic id ceiling is enough to make a retry stable.
 */
export async function readPalletExceptions(
  exec: SqlExecutor,
  limit: number,
  ceilingId?: number | null,
): Promise<PendingPalletException[]> {
  const columns = `id, kind, pallet_id, shift_id, terminal_id, operator_id, reason, occurred_at`;
  const rows =
    ceilingId != null
      ? await exec.all<PalletExceptionRow>(
          `SELECT ${columns} FROM pallet_exceptions_mirror WHERE id <= ? ORDER BY id LIMIT ?`,
          [ceilingId, limit],
        )
      : await exec.all<PalletExceptionRow>(
          `SELECT ${columns} FROM pallet_exceptions_mirror ORDER BY id LIMIT ?`,
          [limit],
        );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind === "disassemble" ? "disassemble" : "reprint",
    palletId: row.pallet_id,
    shiftId: row.shift_id,
    terminalId: row.terminal_id,
    operatorId: row.operator_id,
    reason: row.reason,
    occurredAt: row.occurred_at,
  }));
}

interface PalletExceptionRow {
  id: number;
  kind: string;
  pallet_id: string;
  shift_id: string;
  terminal_id: string | null;
  operator_id: string | null;
  reason: string;
  occurred_at: string;
}

/**
 * Drops everything up to and including `id` -- one statement, the only atomic
 * unit available on the device (see `outbox.ts`'s `ackThrough`). Called only
 * after the server has confirmed the batch, so a crash before it resends.
 */
export async function ackPalletExceptionsThrough(exec: SqlExecutor, id: number): Promise<void> {
  await exec.run("DELETE FROM pallet_exceptions_mirror WHERE id <= ?", [id]);
}

export async function palletExceptionDepth(exec: SqlExecutor): Promise<number> {
  const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM pallet_exceptions_mirror");
  return rows[0]?.n ?? 0;
}

export async function oldestPalletExceptionAt(exec: SqlExecutor): Promise<string | null> {
  const rows = await exec.all<{ occurred_at: string }>(
    "SELECT occurred_at FROM pallet_exceptions_mirror ORDER BY id LIMIT 1",
  );
  return rows[0]?.occurred_at ?? null;
}

/**
 * Returns the oldest unresolved label for this shift AND terminal, or null
 * if none is pending -- the pallet equivalent of `boxes.ts`'s
 * `findUnresolvedBoxPrint`, scoped the same way: a device's mirror can hold
 * pallet rows under more than one `terminal_id` over time (re-enrollment,
 * see `openBox`'s doc comment), and the 06d spec has two terminals in one
 * shift each building their own pallet, so an unscoped query would surface
 * another workstation's unresolved print to the wrong operator.
 */
export async function findUnresolvedPalletPrint(
  exec: SqlExecutor,
  shiftId: string,
  terminalId: string | null,
): Promise<UnresolvedPalletPrint | null> {
  const rows = await exec.all<{
    pallet_id: string;
    sscc: string;
    box_count: number;
    closed_at: string;
    // The WHERE clause below filters on `print_state = 'pending'`, so this
    // is the only value a returned row can ever carry (Task 15 review,
    // Finding 5) -- see `UnresolvedPalletPrint.state`'s own doc comment.
    print_state: "pending";
    print_error_code: BoxPrintErrorCode | null;
  }>(
    `SELECT p.pallet_id AS pallet_id, p.sscc AS sscc,
            (SELECT COUNT(*) FROM boxes_mirror b
              WHERE b.pallet_id = p.pallet_id AND b.disassembled_at IS NULL) AS box_count,
            p.closed_at AS closed_at,
            p.print_state AS print_state, p.print_error_code AS print_error_code
       FROM pallets_mirror p
      WHERE p.shift_id = ? AND p.terminal_id IS ?
        AND p.closed_at IS NOT NULL AND p.sscc IS NOT NULL
        AND p.disassembled_at IS NULL
        AND p.print_state = 'pending'
      ORDER BY p.closed_at ASC, p.pallet_id ASC
      LIMIT 1`,
    [shiftId, terminalId],
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
