import {
  isShiftCloseReasonCode,
  shiftCloseReasonRequired,
  type ShiftCloseReasonCode,
} from "@markiro/domain";
import type { SqlExecutor } from "./mirror.js";

export interface OfflineShiftCloseSummary {
  eventId: string;
  shiftId: string;
  productId: string;
  productName: string;
  plannedQtySnapshot: number | null;
  actualQty: number;
  closedBoxCount: number;
  reasonCode: ShiftCloseReasonCode | null;
  closedAt: string;
}

interface StoredShiftCloseSummary {
  event_id: string;
  shift_id: string;
  product_id: string;
  product_name: string;
  planned_qty_snapshot: number | null;
  actual_qty: number;
  closed_box_count: number;
  reason_code: string | null;
  closed_at: string;
}

function presentStoredClose(row: StoredShiftCloseSummary): OfflineShiftCloseSummary {
  return {
    eventId: row.event_id,
    shiftId: row.shift_id,
    productId: row.product_id,
    productName: row.product_name,
    plannedQtySnapshot: row.planned_qty_snapshot,
    actualQty: row.actual_qty,
    closedBoxCount: row.closed_box_count,
    reasonCode: row.reason_code && isShiftCloseReasonCode(row.reason_code) ? row.reason_code : null,
    closedAt: row.closed_at,
  };
}

async function loadStoredClose(
  exec: SqlExecutor,
  shiftId: string,
): Promise<StoredShiftCloseSummary | undefined> {
  const [storedClose] = await exec.all<StoredShiftCloseSummary>(
    `SELECT event_id, shift_id, product_id, product_name, planned_qty_snapshot,
            actual_qty, closed_box_count, reason_code, closed_at
       FROM shift_close_outbox
      WHERE shift_id = ?
      ORDER BY closed_at
      LIMIT 1`,
    [shiftId],
  );
  return storedClose;
}

function isShiftCloseUniquenessConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed:\s*shift_close_outbox\.shift_id|shift_close_outbox_shift_id_uq/i.test(
    message,
  );
}

async function removeEmptyOpenBoxes(exec: SqlExecutor, shiftId: string): Promise<void> {
  // WorkScreen opens the next box immediately after closing the previous one.
  // It has never been sent to the server and has no contents, so it must not
  // prevent closing the shift or survive a resumed close attempt.
  await exec.run(
    `DELETE FROM boxes_mirror
      WHERE shift_id = ?
        AND closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM codes_mirror c WHERE c.box_id = boxes_mirror.box_id)`,
    [shiftId],
  );
}

export async function closeShiftOffline(
  exec: SqlExecutor,
  input: {
    shiftId: string;
    deviceId: string;
    operatorId: string | null;
    reasonCode?: string | null;
  },
  now: () => Date = () => new Date(),
): Promise<OfflineShiftCloseSummary> {
  const [shift] = await exec.all<{
    id: string;
    product_id: string;
    product_name: string | null;
    planned_qty: number | null;
    status: string;
  }>("SELECT id, product_id, product_name, planned_qty, status FROM shift_mirror WHERE id = ?", [
    input.shiftId,
  ]);
  if (!shift) throw new Error("Shift is not available offline");

  const storedClose = await loadStoredClose(exec, input.shiftId);
  if (storedClose) {
    // A previous attempt may have persisted the durable event before its
    // following mirror updates completed. Resume those idempotent writes and
    // return the original snapshot instead of creating a second close event.
    await removeEmptyOpenBoxes(exec, input.shiftId);
    await exec.run("UPDATE shift_mirror SET status = 'closed' WHERE id = ?", [input.shiftId]);
    return presentStoredClose(storedClose);
  }
  if (shift.status === "closed") throw new Error("Shift is already closed");

  const [{ actualQty = 0 } = {}] = await exec.all<{ actualQty: number }>(
    "SELECT COUNT(*) AS actualQty FROM codes_mirror WHERE shift_id = ?",
    [input.shiftId],
  );
  const [{ closedBoxCount = 0 } = {}] = await exec.all<{ closedBoxCount: number }>(
    "SELECT COUNT(*) AS closedBoxCount FROM boxes_mirror WHERE shift_id = ? AND closed_at IS NOT NULL",
    [input.shiftId],
  );
  const [{ openBoxCount = 0 } = {}] = await exec.all<{ openBoxCount: number }>(
    `SELECT COUNT(*) AS openBoxCount
       FROM boxes_mirror b
      WHERE b.shift_id = ?
        AND b.closed_at IS NULL
        AND EXISTS (SELECT 1 FROM codes_mirror c WHERE c.box_id = b.box_id)`,
    [input.shiftId],
  );
  if (openBoxCount > 0) throw new Error("Close the open box before closing the shift");
  const reason = input.reasonCode ?? null;
  if (
    shiftCloseReasonRequired(shift.planned_qty, actualQty) &&
    (!reason || !isShiftCloseReasonCode(reason))
  ) {
    throw new Error("A close reason is required");
  }
  if (reason !== null && !isShiftCloseReasonCode(reason)) throw new Error("Unknown close reason");

  const closedAt = now().toISOString();
  const eventId = crypto.randomUUID();
  // Do not use BEGIN/COMMIT here: tauri-plugin-sql may dispatch consecutive
  // executor calls to different pooled SQLite connections. Persist the close
  // fact first, then make the remaining writes idempotent so a retry can
  // finish them safely after an interruption.
  try {
    await exec.run(
      `INSERT INTO shift_close_outbox
       (event_id, shift_id, device_id, operator_id, product_id, product_name,
        planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        input.shiftId,
        input.deviceId,
        input.operatorId,
        shift.product_id,
        shift.product_name ?? "",
        shift.planned_qty,
        actualQty,
        closedBoxCount,
        reason,
        closedAt,
      ],
    );
  } catch (error) {
    if (!isShiftCloseUniquenessConflict(error)) throw error;
    const concurrentClose = await loadStoredClose(exec, input.shiftId);
    if (!concurrentClose) throw error;
    await removeEmptyOpenBoxes(exec, input.shiftId);
    await exec.run("UPDATE shift_mirror SET status = 'closed' WHERE id = ?", [input.shiftId]);
    return presentStoredClose(concurrentClose);
  }
  await removeEmptyOpenBoxes(exec, input.shiftId);
  await exec.run("UPDATE shift_mirror SET status = 'closed' WHERE id = ?", [input.shiftId]);
  return {
    eventId,
    shiftId: input.shiftId,
    productId: shift.product_id,
    productName: shift.product_name ?? "",
    plannedQtySnapshot: shift.planned_qty,
    actualQty,
    closedBoxCount,
    reasonCode: reason,
    closedAt,
  };
}

export interface PendingShiftClose {
  event_id: string;
  shift_id: string;
  device_id: string;
  operator_id: string | null;
  planned_qty_snapshot: number | null;
  actual_qty: number;
  closed_box_count: number;
  reason_code: string | null;
  closed_at: string;
}

export function readPendingShiftCloses(exec: SqlExecutor): Promise<PendingShiftClose[]> {
  return exec.all<PendingShiftClose>(
    `SELECT event_id, shift_id, device_id, operator_id, planned_qty_snapshot,
            actual_qty, closed_box_count, reason_code, closed_at
       FROM shift_close_outbox WHERE state = 'pending' ORDER BY closed_at`,
  );
}

export async function markShiftCloseAccepted(exec: SqlExecutor, eventId: string): Promise<void> {
  await exec.run("DELETE FROM shift_close_outbox WHERE event_id = ?", [eventId]);
}

export async function markShiftCloseConflict(
  exec: SqlExecutor,
  eventId: string,
  code: string,
): Promise<void> {
  await exec.run(
    "UPDATE shift_close_outbox SET state = 'conflict', conflict_code = ?, last_checked_at = ? WHERE event_id = ?",
    [code, new Date().toISOString(), eventId],
  );
}
