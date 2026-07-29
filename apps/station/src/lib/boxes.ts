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
  sscc: string | null;
  itemCount: number;
  openedAt: string;
  closedAt: string | null;
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
    sscc: string | null;
    opened_at: string;
    closed_at: string | null;
    item_count: number;
  }>(
    `SELECT b.box_id AS box_id, b.shift_id AS shift_id, b.sscc AS sscc,
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
    sscc: row.sscc,
    itemCount: Number(row.item_count),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

/** Opens a new box for this shift. One INSERT; every other column defaults to null. */
export async function openBox(
  exec: SqlExecutor,
  shiftId: string,
  boxId: string,
  openedAt: string,
): Promise<void> {
  await exec.run(`INSERT INTO boxes_mirror (box_id, shift_id, opened_at) VALUES (?,?,?)`, [
    boxId,
    shiftId,
    openedAt,
  ]);
}

/**
 * Closes a box once its SSCC has been assigned. One UPDATE, setting `sscc`,
 * `closed_at` and `closed_by` (the operator who closed it, if known) — this
 * is what removes the box from `currentBox`'s `closed_at IS NULL` filter.
 */
export async function closeBox(
  exec: SqlExecutor,
  boxId: string,
  sscc: string,
  closedAt: string,
  operatorId: string | null,
): Promise<void> {
  await exec.run(
    `UPDATE boxes_mirror SET sscc = ?, closed_at = ?, closed_by = ? WHERE box_id = ?`,
    [sscc, closedAt, operatorId, boxId],
  );
}
