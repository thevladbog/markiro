import {
  isShiftCloseReasonCode,
  shiftCloseReasonRequired,
  type ShiftCloseReasonCode,
} from "@markiro/domain";
import type { SqlExecutor } from "./mirror.js";
import type { CredentialGeneration } from "./credential-recovery.js";
import { acquireCredentialCommitLease } from "./credential-recovery.js";
import {
  StationGrantAdmission,
  stationOperatorIsCurrentlyActive,
} from "./offline-grants/admission.js";
import { sampleGrantClock, type GrantClockSample } from "./offline-grants/clock.js";
import { readExecutionToBind, readShiftExecutionProjection } from "./offline-grants/semantic.js";

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

async function closeShiftOfflineLegacy(
  exec: SqlExecutor,
  input: {
    shiftId: string;
    deviceId: string;
    operatorId: string | null;
    reasonCode?: string | null;
    credentialOwnership?: string;
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

  const [printPolicy] = await exec.all<{ enabled: number }>(
    "SELECT json_extract(validation_print_context,'$.policy.mode')='duplicate_dm' AS enabled FROM shift_mirror WHERE id=?",
    [input.shiftId],
  );
  if (printPolicy?.enabled === 1) {
    if (!input.credentialOwnership) throw new Error("PRODUCT_LABEL_CREDENTIAL_REQUIRED");
    const [foreign] = await exec.all<{ job_id: string }>(
      "SELECT job_id FROM product_label_jobs WHERE shift_id=? AND credential_ownership<>? LIMIT 1",
      [input.shiftId, input.credentialOwnership],
    );
    if (foreign) throw new Error("PRODUCT_LABEL_CREDENTIAL_MISMATCH");
    const [pending] = await exec.all<{ job_id: string }>(
      "SELECT job_id FROM product_label_jobs WHERE shift_id=? AND status<>'completed' LIMIT 1",
      [input.shiftId],
    );
    if (pending) throw new Error("PRODUCT_LABEL_UNRESOLVED");
  }

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
    "SELECT COUNT(*) AS actualQty FROM station_processed_codes WHERE shift_id = ?",
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

export async function closeShiftOffline(
  exec: SqlExecutor,
  input: Parameters<typeof closeShiftOfflineLegacy>[1],
  now: () => Date = () => new Date(),
): Promise<OfflineShiftCloseSummary> {
  const [active] = await exec.all<{ active: number }>(
    "SELECT 1 active FROM offline_grant_install_state WHERE id=1",
  );
  if (active?.active === 1) throw new Error("offline grant-aware shift close owner required");
  return closeShiftOfflineLegacy(exec, input, now);
}

/** Current close owner: closure snapshot, task charge and mirror transition commit together. */
export async function closeShiftOfflineWithGrant(
  exec: SqlExecutor,
  input: Parameters<typeof closeShiftOfflineLegacy>[1],
  generation: CredentialGeneration,
  now: () => Date = () => new Date(),
  clock: () => Promise<GrantClockSample> = sampleGrantClock,
): Promise<OfflineShiftCloseSummary> {
  const lease = acquireCredentialCommitLease(generation);
  if (!lease) throw new Error("offline grant stale credential");
  try {
    const [state] = await exec.all<{
      tenant_id: string;
      device_id: string;
      owner_kind: "station";
      credential_epoch: number;
      mode: "observe" | "strict";
    }>(
      "SELECT tenant_id,device_id,owner_kind,credential_epoch,mode FROM offline_grant_install_state WHERE id=1",
    );
    if (!state) return closeShiftOfflineLegacy(exec, input, now);
    if (!input.operatorId) throw new Error("offline grant operator unauthorized");
    if (!(await stationOperatorIsCurrentlyActive(exec, input.operatorId)))
      throw new Error("offline grant operator unauthorized");
    const stored = await loadStoredClose(exec, input.shiftId);
    if (stored) {
      // Same resume as the ungranted path: the durable event can outlive the
      // mirror writes that follow it (a restart mid-close). Returning the
      // snapshot without finishing them leaves the shift showing active on the
      // terminal, so the operator closes a shift that is already closed.
      await removeEmptyOpenBoxes(exec, input.shiftId);
      await exec.run("UPDATE shift_mirror SET status = 'closed' WHERE id = ?", [input.shiftId]);
      return presentStoredClose(stored);
    }
    const [shift] = await exec.all<{
      id: string;
      product_id: string;
      product_name: string | null;
      planned_qty: number | null;
      status: string;
    }>("SELECT id,product_id,product_name,planned_qty,status FROM shift_mirror WHERE id=?", [
      input.shiftId,
    ]);
    if (!shift || shift.status === "closed") throw new Error("Shift is not available offline");
    const [printPolicy] = await exec.all<{ enabled: number }>(
      "SELECT json_extract(validation_print_context,'$.policy.mode')='duplicate_dm' AS enabled FROM shift_mirror WHERE id=?",
      [input.shiftId],
    );
    if (printPolicy?.enabled === 1) {
      if (!input.credentialOwnership) throw new Error("PRODUCT_LABEL_CREDENTIAL_REQUIRED");
      const [foreign] = await exec.all<{ job_id: string }>(
        "SELECT job_id FROM product_label_jobs WHERE shift_id=? AND credential_ownership<>? LIMIT 1",
        [input.shiftId, input.credentialOwnership],
      );
      if (foreign) throw new Error("PRODUCT_LABEL_CREDENTIAL_MISMATCH");
      const [pending] = await exec.all<{ job_id: string }>(
        "SELECT job_id FROM product_label_jobs WHERE shift_id=? AND status<>'completed' LIMIT 1",
        [input.shiftId],
      );
      if (pending) throw new Error("PRODUCT_LABEL_UNRESOLVED");
    }
    const [{ actualQty = 0 } = {}] = await exec.all<{ actualQty: number }>(
      "SELECT COUNT(*) actualQty FROM codes_mirror WHERE shift_id=?",
      [input.shiftId],
    );
    const [{ closedBoxCount = 0 } = {}] = await exec.all<{ closedBoxCount: number }>(
      "SELECT COUNT(*) closedBoxCount FROM boxes_mirror WHERE shift_id=? AND closed_at IS NOT NULL",
      [input.shiftId],
    );
    const [{ openBoxCount = 0 } = {}] = await exec.all<{ openBoxCount: number }>(
      `SELECT COUNT(*) openBoxCount FROM boxes_mirror b WHERE b.shift_id=? AND b.closed_at IS NULL AND EXISTS(SELECT 1 FROM codes_mirror c WHERE c.box_id=b.box_id)`,
      [input.shiftId],
    );
    if (openBoxCount > 0) throw new Error("Close the open box before closing the shift");
    const reason = input.reasonCode ?? null;
    if (
      shiftCloseReasonRequired(shift.planned_qty, actualQty) &&
      (!reason || !isShiftCloseReasonCode(reason))
    )
      throw new Error("A close reason is required");
    if (reason !== null && !isShiftCloseReasonCode(reason)) throw new Error("Unknown close reason");
    const [binding] = await exec.all<{ snapshot_digest: string }>(
      `SELECT json_extract(grant_json,'$.snapshotDigest') snapshot_digest FROM offline_grant_grants WHERE json_extract(grant_json,'$.kindOfGrant')='task' AND json_extract(grant_json,'$.taskKind')='shift' AND json_extract(grant_json,'$.taskId')=? ORDER BY installed_sequence DESC LIMIT 1`,
      [input.shiftId],
    );
    // A shift this device cannot bind must still close where grants only
    // observe; refusing here left the shift open with no way to finish it.
    const execution = await readExecutionToBind(state.mode, () =>
      readShiftExecutionProjection(exec, input.shiftId),
    );
    if (!execution) return closeShiftOfflineLegacy(exec, input, now);
    const closedAt = now().toISOString(),
      eventId = crypto.randomUUID();
    const result: OfflineShiftCloseSummary = {
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
    const committed = await new StationGrantAdmission(exec, clock).commitCompletion({
      operatorId: input.operatorId,
      intent: {
        owner: {
          tenantId: state.tenant_id,
          deviceId: state.device_id,
          kind: state.owner_kind,
          credentialEpoch: state.credential_epoch,
        },
        capability: "shift.start.v1",
        taskId: input.shiftId,
        snapshotDigest: binding?.snapshot_digest ?? "missing",
        eventId,
        eventType: "shift.close.v1",
        cost: {},
      },
      execution,
      event: result,
      facts: {},
      result,
      ownerStatements: [
        {
          sql: `DELETE FROM boxes_mirror WHERE shift_id=? AND closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM codes_mirror c WHERE c.box_id=boxes_mirror.box_id)`,
          values: [input.shiftId],
        },
        {
          sql: `INSERT INTO shift_close_outbox(event_id,shift_id,device_id,operator_id,product_id,product_name,planned_qty_snapshot,actual_qty,closed_box_count,reason_code,closed_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE json_extract((SELECT decision_json FROM offline_grant_decisions WHERE event_id=?),'$.allow')=1`,
          values: [
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
            eventId,
          ],
        },
        {
          sql: `UPDATE shift_mirror SET status='closed' WHERE id=? AND json_extract((SELECT decision_json FROM offline_grant_decisions WHERE event_id=?),'$.allow')=1`,
          values: [input.shiftId, eventId],
        },
      ],
    });
    if (!committed.decision.allow)
      throw new Error(`offline grant denied: ${committed.decision.reason}`);
    return committed.result as OfflineShiftCloseSummary;
  } catch (error) {
    // The pre-check above cannot see a close another owner commits while this
    // one is in flight. The ungranted path resolves that race into the stored
    // close instead of an error, and so must this one: the shift IS closed,
    // and telling the operator otherwise sends them to close it twice.
    if (!isShiftCloseUniquenessConflict(error)) throw error;
    const concurrentClose = await loadStoredClose(exec, input.shiftId);
    if (!concurrentClose) throw error;
    await removeEmptyOpenBoxes(exec, input.shiftId);
    await exec.run("UPDATE shift_mirror SET status = 'closed' WHERE id = ?", [input.shiftId]);
    return presentStoredClose(concurrentClose);
  } finally {
    lease.release();
  }
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
  // Repair a mirror overwritten by an older client before discarding the
  // durable close event. A failed write leaves the event available for retry.
  await exec.run(
    "UPDATE shift_mirror SET status = 'closed' WHERE id = (SELECT shift_id FROM shift_close_outbox WHERE event_id = ?)",
    [eventId],
  );
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
