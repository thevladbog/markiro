import { isShiftCloseReasonCode, shiftCloseReasonRequired, type ShiftCloseReasonCode } from "@markiro/domain";
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

export async function closeShiftOffline(
  exec: SqlExecutor,
  input: { shiftId: string; deviceId: string; operatorId: string | null; reasonCode?: string | null },
  now: () => Date = () => new Date(),
): Promise<OfflineShiftCloseSummary> {
  const [shift] = await exec.all<{
    id: string;
    product_id: string;
    product_name: string | null;
    planned_qty: number | null;
    status: string;
  }>("SELECT id, product_id, product_name, planned_qty, status FROM shift_mirror WHERE id = ?", [input.shiftId]);
  if (!shift) throw new Error("Shift is not available offline");
  if (shift.status === "closed") throw new Error("Shift is already closed");

  const [{ actualQty = 0 } = {}] = await exec.all<{ actualQty: number }>(
    "SELECT COUNT(*) AS actualQty FROM codes_mirror WHERE shift_id = ?",
    [input.shiftId],
  );
  const [{ closedBoxCount = 0 } = {}] = await exec.all<{ closedBoxCount: number }>(
    "SELECT COUNT(*) AS closedBoxCount FROM boxes_mirror WHERE shift_id = ? AND closed_at IS NOT NULL",
    [input.shiftId],
  );
  const reason = input.reasonCode ?? null;
  if (shiftCloseReasonRequired(shift.planned_qty, actualQty) && (!reason || !isShiftCloseReasonCode(reason))) {
    throw new Error("A close reason is required");
  }
  if (reason !== null && !isShiftCloseReasonCode(reason)) throw new Error("Unknown close reason");

  const closedAt = now().toISOString();
  const eventId = crypto.randomUUID();
  await exec.run("BEGIN");
  try {
    await exec.run("UPDATE shift_mirror SET status = 'closed' WHERE id = ?", [input.shiftId]);
    await exec.run(
      `INSERT INTO shift_close_outbox
       (event_id, shift_id, device_id, operator_id, product_id, product_name,
        planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, input.shiftId, input.deviceId, input.operatorId, shift.product_id, shift.product_name ?? "", shift.planned_qty, actualQty, closedBoxCount, reason, closedAt],
    );
    await exec.run("COMMIT");
  } catch (error) {
    await exec.run("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return {
    eventId,
    shiftId: input.shiftId,
    productId: shift.product_id,
    productName: shift.product_name ?? "",
    plannedQtySnapshot: shift.planned_qty,
    actualQty,
    closedBoxCount,
    reasonCode: reason as ShiftCloseReasonCode | null,
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

export async function markShiftCloseConflict(exec: SqlExecutor, eventId: string, code: string): Promise<void> {
  await exec.run("UPDATE shift_close_outbox SET state = 'conflict', conflict_code = ?, last_checked_at = ? WHERE event_id = ?", [code, new Date().toISOString(), eventId]);
}
