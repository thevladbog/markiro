import { insertException } from "./box-exceptions-mirror.js";
import type { SqlExecutor } from "./mirror.js";

/**
 * A transport box on this device, as tracked by `boxes_mirror`.
 *
 * Box membership of a scanned code is a column on `codes_mirror`
 * (`box_id`), not a join table — see `recordScan`'s doc comment in
 * `journal.ts` for why a fourth write was rejected there. `itemCount` is
 * therefore always derived by counting `codes_mirror` rows that name this
 * box, never stored.
 */
export interface DeviceBox {
  boxId: string;
  shiftId: string;
  terminalId: string | null;
  sscc: string | null;
  itemCount: number;
  openedAt: string;
  closedAt: string | null;
}

export type BoxPrintState = "legacy" | "pending" | "printed" | "skipped";

export type BoxPrintErrorCode =
  "template_missing" | "printer_unconfigured" | "render_failed" | "transport_failed";

export interface UnresolvedBoxPrint {
  boxId: string;
  sscc: string;
  itemCount: number;
  /**
   * The box's OWN closure timestamp, read back off `boxes_mirror` — not
   * "now". The box label prints «Дата производства» and «Годен до» derived
   * from it (`box-label.ts`'s `boxLabelFields`), so a recovery print issued
   * the next morning would otherwise stamp today's date and today + shelf
   * life: two physical labels for the same SSCC bearing different expiry
   * dates. Carrying the persisted value makes a given box print the same
   * dates no matter when it is reprinted.
   *
   * Non-null by construction: `findUnresolvedBoxPrint` only ever returns
   * rows with `closed_at IS NOT NULL`.
   */
  closedAt: string;
  state: "pending" | "printed";
  errorCode: BoxPrintErrorCode | null;
}

/**
 * The one box open for this shift right now (`closed_at IS NULL`), or null
 * if none is open. `itemCount` is a `COUNT(*)` over `codes_mirror` correlated
 * by `box_id` — NOT by `shift_id` — so a code scanned into a different box
 * (whether opened under this same shift or another) never inflates this
 * box's count. `box_id` is a plain, unenforced column, but in practice it is
 * unique to the one box it names, which is exactly what this correlation
 * relies on.
 */
export async function currentBox(exec: SqlExecutor, shiftId: string): Promise<DeviceBox | null> {
  const rows = await exec.all<{
    box_id: string;
    shift_id: string;
    terminal_id: string | null;
    sscc: string | null;
    opened_at: string;
    closed_at: string | null;
    item_count: number;
  }>(
    `SELECT b.box_id AS box_id, b.shift_id AS shift_id, b.terminal_id AS terminal_id, b.sscc AS sscc,
            b.opened_at AS opened_at, b.closed_at AS closed_at,
            (SELECT COUNT(*) FROM codes_mirror c WHERE c.box_id = b.box_id) AS item_count
     FROM boxes_mirror b
     WHERE b.shift_id = ? AND b.closed_at IS NULL`,
    [shiftId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    boxId: row.box_id,
    shiftId: row.shift_id,
    terminalId: row.terminal_id,
    sscc: row.sscc,
    itemCount: Number(row.item_count),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

/**
 * Stable display-only box number within this shift and terminal. The SSCC is
 * deliberately unrelated: this count is derived from persisted local rows so
 * a restart cannot reset the floor aid or consume a serial.
 */
export async function boxOrdinal(
  exec: SqlExecutor,
  shiftId: string,
  terminalId: string | null,
  boxId: string,
): Promise<number> {
  const currentRows = await exec.all<{ opened_at: string }>(
    `SELECT opened_at
       FROM boxes_mirror
      WHERE shift_id = ? AND terminal_id IS ? AND box_id = ?`,
    [shiftId, terminalId, boxId],
  );
  const openedAt = currentRows[0]?.opened_at;
  // A legacy/re-enrolled row can carry an identity the caller cannot resolve.
  // The ordinal is only a floor aid, so degrade to the first human number
  // rather than ever rendering the impossible "Box no. 0".
  if (openedAt === undefined) return 1;

  const rows = await exec.all<{ ordinal: number }>(
    `SELECT COUNT(*) AS ordinal
       FROM boxes_mirror candidate
      WHERE candidate.shift_id = ?
        AND candidate.terminal_id IS ?
        AND (
          candidate.opened_at < ?
          OR (candidate.opened_at = ? AND candidate.box_id <= ?)
        )`,
    [shiftId, terminalId, openedAt, openedAt, boxId],
  );
  return Math.max(1, Number(rows[0]?.ordinal ?? 0));
}

/**
 * Opens a new box for this shift. One INSERT; every other column defaults
 * to null.
 *
 * `terminalId` is captured here, at open time, and never re-derived later:
 * `deviceId`/terminalId lives in `station.json`, not this SQLite mirror, and
 * can change (e.g. re-enrollment) independently of a box that is still open
 * in the local database. The sync engine's closure report reads it back off
 * this row rather than whatever the device considers "current" when it
 * happens to drain (Task 11) -- otherwise a box open across such a change
 * would report the wrong terminal, or a shift change would make it never
 * match the server's row at all.
 */
export async function openBox(
  exec: SqlExecutor,
  shiftId: string,
  boxId: string,
  openedAt: string,
  terminalId: string | null,
): Promise<void> {
  await exec.run(
    `INSERT INTO boxes_mirror (box_id, shift_id, terminal_id, opened_at) VALUES (?,?,?,?)`,
    [boxId, shiftId, terminalId, openedAt],
  );
}

/**
 * Closes a box once its SSCC has been assigned. The same UPDATE records the
 * local pending label, so a crash cannot persist the close without recovery.
 */
export async function closeBox(
  exec: SqlExecutor,
  boxId: string,
  sscc: string,
  closedAt: string,
  operatorId: string | null,
): Promise<void> {
  await exec.run(
    `UPDATE boxes_mirror
        SET sscc = ?, closed_at = ?, closed_by = ?,
            print_state = 'pending', print_error_code = NULL
      WHERE box_id = ?`,
    [sscc, closedAt, operatorId, boxId],
  );
}

/** Records an actionable category without persisting a native printer error. */
export async function markBoxPrintFailed(
  exec: SqlExecutor,
  boxId: string,
  code: BoxPrintErrorCode,
): Promise<void> {
  await exec.run(
    `UPDATE boxes_mirror
        SET print_state = 'pending', print_error_code = ?
      WHERE box_id = ? AND print_state = 'pending'`,
    [code, boxId],
  );
}

/** Records successful output for this already-numbered box. */
export async function markBoxPrinted(exec: SqlExecutor, boxId: string): Promise<void> {
  await exec.run(
    `UPDATE boxes_mirror
        SET print_state = 'printed', print_error_code = NULL
      WHERE box_id = ? AND print_state = 'pending'`,
    [boxId],
  );
}

/**
 * Returns the oldest unresolved label owned by this aggregation shift and
 * terminal. Printed labels are included only while scan-back verification is
 * active and neither durable verification outcome has been recorded.
 */
export async function findUnresolvedBoxPrint(
  exec: SqlExecutor,
  shiftId: string,
  terminalId: string | null,
  includePrintedForVerification: boolean,
): Promise<UnresolvedBoxPrint | null> {
  const rows = await exec.all<{
    box_id: string;
    sscc: string;
    item_count: number;
    closed_at: string;
    print_state: "pending" | "printed";
    print_error_code: BoxPrintErrorCode | null;
  }>(
    `SELECT b.box_id AS box_id, b.sscc AS sscc,
            (SELECT COUNT(*) FROM codes_mirror c WHERE c.box_id = b.box_id) AS item_count,
            b.closed_at AS closed_at,
            b.print_state AS print_state, b.print_error_code AS print_error_code
       FROM boxes_mirror b
       JOIN shift_mirror s
         ON s.id = b.shift_id
        AND s.mode = 'aggregation'
        AND s.issuer_prefix IS NOT NULL
      WHERE b.shift_id = ? AND b.terminal_id IS ?
        AND b.closed_at IS NOT NULL AND b.sscc IS NOT NULL
        AND b.disassembled_at IS NULL
        AND (
          b.print_state = 'pending'
          OR (
            ? = 1 AND b.print_state = 'printed'
            AND b.print_verified_at IS NULL AND b.print_skipped_at IS NULL
          )
        )
      ORDER BY b.closed_at ASC, b.box_id ASC
      LIMIT 1`,
    [shiftId, terminalId, includePrintedForVerification ? 1 : 0],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    boxId: row.box_id,
    sscc: row.sscc,
    itemCount: Number(row.item_count),
    closedAt: row.closed_at,
    state: row.print_state,
    errorCode: row.print_error_code,
  };
}

/**
 * Records that a closed box's printed label was scanned back and matched --
 * `PrintVerification`'s `onVerified` path. Also clears `acked_at` on the SAME
 * row (Task 13 review, Finding 1): the sync engine's box-closure query
 * (`sync.ts`'s `readClosedUnackedBoxes`) is gated on `acked_at IS NULL`, and
 * `ackBoxes` sets it on every successful drain -- which typically happens
 * within seconds of the box closing, well before the operator resolves this
 * prompt. Without re-clearing it here, the outcome this write just recorded
 * would have no way off the device: the closure was already acked, so it
 * would never be read by `readClosedUnackedBoxes` again. Clearing it un-gates
 * exactly one more resend of THIS box's closure, carrying the now-resolved
 * outcome -- `closed_at`/`sscc`/every other already-acked column on this row
 * is untouched, and the server's own late-update UPDATE only ever writes
 * `print_verified_at`/`print_skipped_at` in response, so a resend here costs
 * nothing beyond one extra (idempotent) closure in the next batch.
 */
export async function markPrintVerified(
  exec: SqlExecutor,
  boxId: string,
  at: string,
): Promise<boolean> {
  const rows = await exec.all<{ box_id: string }>(
    `UPDATE boxes_mirror
        SET print_state = 'printed', print_error_code = NULL,
            print_verified_at = ?, acked_at = NULL
      WHERE box_id = ? AND print_state IN ('pending', 'printed')
        AND print_verified_at IS NULL AND print_skipped_at IS NULL
      RETURNING box_id`,
    [at, boxId],
  );
  return rows.length === 1;
}

/**
 * Records that the operator explicitly chose NOT to verify a closed box's
 * printed label -- a disconnected scanner or a ruined label. A skip is
 * recorded, not silently dropped, which is exactly what this column (idle
 * since it was added in Task 9) exists for. Clears `acked_at` for the same
 * reason `markPrintVerified` above does -- see its doc comment.
 */
export async function markPrintSkipped(
  exec: SqlExecutor,
  boxId: string,
  at: string,
): Promise<boolean> {
  const rows = await exec.all<{ box_id: string }>(
    `UPDATE boxes_mirror
        SET print_state = 'skipped', print_error_code = NULL,
            print_skipped_at = ?, acked_at = NULL
      WHERE box_id = ? AND print_state IN ('pending', 'printed')
        AND print_verified_at IS NULL AND print_skipped_at IS NULL
      RETURNING box_id`,
    [at, boxId],
  );
  return rows.length === 1;
}

export interface ClearBoxInput {
  boxId: string;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  at: string;
}

/**
 * Empties every code from a still-open box and queues the fact -- the
 * "start over without closing" shortcut (design spec's fourth action).
 * Does NOT touch closed_at/sscc/disassembled_at: the box stays open, ready
 * to be filled again. No reason is recorded (see the design spec, scope
 * decision 5) -- nothing has been printed or numbered yet.
 */
export async function clearBox(exec: SqlExecutor, input: ClearBoxInput): Promise<void> {
  await insertException(exec, {
    kind: "clear",
    boxId: input.boxId,
    codeHash: null,
    targetScannedAt: null,
    shiftId: input.shiftId,
    terminalId: input.terminalId,
    operatorId: input.operatorId,
    reason: null,
    at: input.at,
  });
}

export interface ReasonedBoxActionInput {
  boxId: string;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  reason: string;
  at: string;
}

/**
 * Retires a closed box: frees every code it still held and marks the
 * mirror row disassembled, so it drops out of `listClosedBoxes` and can
 * never be reprinted or disassembled again. The server independently
 * voids the box's SSCC forever (see the design spec's scope decision 4) --
 * a re-packed box is a brand-new box row with a brand-new SSCC.
 */
export async function disassembleBox(
  exec: SqlExecutor,
  input: ReasonedBoxActionInput,
): Promise<void> {
  await insertException(exec, {
    kind: "disassemble",
    boxId: input.boxId,
    codeHash: null,
    targetScannedAt: null,
    shiftId: input.shiftId,
    terminalId: input.terminalId,
    operatorId: input.operatorId,
    reason: input.reason,
    at: input.at,
  });
}

/** Queues an unchanged label reprint for a closed box. */
export async function reprintBox(exec: SqlExecutor, input: ReasonedBoxActionInput): Promise<void> {
  await insertException(exec, {
    kind: "reprint",
    boxId: input.boxId,
    codeHash: null,
    targetScannedAt: null,
    shiftId: input.shiftId,
    terminalId: input.terminalId,
    operatorId: input.operatorId,
    reason: input.reason,
    at: input.at,
  });
}

export interface ClosedBoxSummary {
  boxId: string;
  sscc: string;
  itemCount: number;
  closedAt: string;
}

/**
 * Closed, not-yet-disassembled boxes for this shift and terminal, most
 * recently closed first -- the picker for the reprint/disassemble panel
 * (Task 14). Scoped to `terminalId` (Task 11's own scope decision 3): an
 * operator manages what physically closed at their own workstation.
 */
export async function listClosedBoxes(
  exec: SqlExecutor,
  shiftId: string,
  terminalId: string | null,
): Promise<ClosedBoxSummary[]> {
  const rows = await exec.all<{
    box_id: string;
    sscc: string;
    closed_at: string;
    item_count: number;
  }>(
    `SELECT b.box_id AS box_id, b.sscc AS sscc, b.closed_at AS closed_at,
            (SELECT COUNT(*) FROM codes_mirror c WHERE c.box_id = b.box_id) AS item_count
       FROM boxes_mirror b
      WHERE b.shift_id = ? AND b.terminal_id IS ?
        AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL
      ORDER BY b.closed_at DESC`,
    [shiftId, terminalId],
  );
  return rows.map((r) => ({
    boxId: r.box_id,
    sscc: r.sscc,
    itemCount: Number(r.item_count),
    closedAt: r.closed_at,
  }));
}
