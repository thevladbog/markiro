import { z } from "zod";

import { shellActionFor } from "../app/shell.js";
import { participationStatement } from "../floor/shifts/shift-participation.js";
import { HostError } from "../host/client.js";
import type { DeviceShift, ShiftLeave } from "../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

/** `HostApi.leaveShift`: the pause of one shift, with this station's leave token or no body. */
export type LeaveShift = (shiftId: string, leave: ShiftLeave | null) => Promise<DeviceShift>;

/**
 * This pairing's pauses the host has not answered, with this station's leave token of each
 * (`joined_rev`, host D5 as amended); parameters: host id, device id.
 */
export const PENDING_LEAVES_SQL =
  "SELECT shift_id, leave_requested_at, joined_rev FROM floor_shift_participation " +
  "WHERE host_id = ? AND device_id = ? AND leave_requested_at IS NOT NULL " +
  "ORDER BY leave_requested_at, shift_id";

/**
 * A pause settled: only the request that was sent, so a newer one asked meanwhile stays.
 * Parameters: host id, device id, shift id, the instant of the request sent.
 */
export const SETTLE_LEAVE_SQL =
  "UPDATE floor_shift_participation SET leave_requested_at = NULL " +
  "WHERE host_id = ? AND device_id = ? AND shift_id = ? AND leave_requested_at = ?";

const pendingRow = z.object({
  shift_id: z.string(),
  leave_requested_at: z.string(),
  joined_rev: z.number().int().nonnegative().nullable(),
});

/**
 * The host will never take this pause, whatever the link or the key: the device never entered, the
 * shift is gone, or the host rejected the request itself (`validation_failed`: a malformed path or
 * body, which the same bytes would meet again). These are the only answers of the leave route
 * (`leave_shift`) that belong to this one shift. Everything else — a transport failure, a 5xx, a
 * refused key (`unauthorized`), `forbidden` (the device's kind or standing, not the shift), an
 * unknown `conflict` — may pass later or says nothing of this shift, so the pause stays queued.
 */
function permanent(error: unknown): boolean {
  return (
    error instanceof HostError &&
    error.kind === "api" &&
    (error.code === "not_found" ||
      error.code === "validation_failed" ||
      (error.code === "conflict" && error.details["constraint"] === "shift_not_entered"))
  );
}

/**
 * Sends this pairing's pauses (plan 2b, `POST /v1/device/shifts/{id}/leave`, host D5), oldest
 * first, each with this station's leave token (`{ joinedRev }`; no body when none is kept): each
 * answer's figures go into the cache with the pause settled in one transaction; a pause the host
 * owes nothing for is settled without figures; any other failure — the host away, a refused key —
 * is kept and goes back to the link, after the other pauses were tried (each pause stands on its own:
 * one that fails does not hold the rest; a refused key or a changed certificate, which the link
 * acts on, goes before any other failure). A pause an entry dropped
 * meanwhile is not sent (the read is fresh), and one asked again after the send is not settled by
 * the older answer. An answer whose `myState` is still `active` to a sent token means the host saw
 * a later entry and wrote nothing (a stale pause): it is settled as "already re-entered" and counted
 * as `stale`, not as `sent`. Answers how many the host took and how many were stale.
 */
export async function sendPendingLeaves(
  local: LocalExecutor,
  pairing: Pairing,
  leave: LeaveShift,
  now: () => Date,
): Promise<{ sent: number; stale: number }> {
  const pending = await local.query(
    PENDING_LEAVES_SQL,
    [pairing.hostId, pairing.deviceId],
    pendingRow,
  );
  let sent = 0;
  let stale = 0;
  let failure: Error | null = null;
  for (const row of pending) {
    const settle: LocalStatement = {
      sql: SETTLE_LEAVE_SQL,
      values: [pairing.hostId, pairing.deviceId, row.shift_id, row.leave_requested_at],
    };
    const token: ShiftLeave | null = row.joined_rev === null ? null : { joinedRev: row.joined_rev };
    let answer: DeviceShift;
    try {
      answer = await leave(row.shift_id, token);
    } catch (error) {
      if (!permanent(error)) {
        // The link acts on a refused key or a changed host: that one outranks the earlier failure.
        if (failure === null || shellActionFor(error, null) !== null) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        continue;
      }
      await local.transaction([settle]);
      continue;
    }
    await local.transaction([participationStatement(pairing, [answer], now().getTime()), settle]);
    if (token !== null && answer.myState === "active") stale += 1;
    else sent += 1;
  }
  if (failure !== null) throw failure;
  return { sent, stale };
}
