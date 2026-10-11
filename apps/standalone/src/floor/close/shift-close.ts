import {
  isShiftCloseReasonCode,
  shiftCloseReasonRequired,
  type ShiftCloseReasonCode,
} from "@markiro/domain";
import { z } from "zod";

import type { ShiftClosedFact } from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { outboxStatement, shiftClosedRecord } from "../facts.js";
import { OPEN_JOB_SQL } from "../print/print-jobs.js";
import { readShiftCopy } from "../shifts/shift-copies.js";
import type { BoxContext } from "../work/box-close.js";

/**
 * What keeps the shift from closing now (stage 2a spec §5.7.7): an open box
 * with codes, which the operator closes or clears first; a label of the
 * shift that still waits for the printer or the operator (plan 2a7's
 * `shiftLabelsSettled`: a label decided after the close would reach the host
 * after `shift_closed` and mark the station's own shift late); or this
 * station has closed it already. The pallets' plan (ПЛ-Ц) adds an open
 * pallet with boxes.
 */
export type CloseBlocker =
  { kind: "open_box"; items: number } | { kind: "label" } | { kind: "closed" };

/** The summary of the close (the cloud's close summary), from this station's own records. */
export interface CloseSummary {
  /** The plan as this station's copy has it now: the record carries it as the plan it saw. */
  plannedQty: number | null;
  /** Codes this station holds in the shift's boxes: the shift's actual quantity. */
  actualQty: number;
  /** The shift's closed boxes not taken apart. */
  closedBoxes: number;
  /** The plan is given and not met: one of the domain's six reasons is needed. */
  reasonRequired: boolean;
  blocker: CloseBlocker | null;
}

const summaryRow = z.object({
  local_state: z.string().nullable(),
  actual: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  open_items: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
});

/** The counts of the shift's codes and closed boxes, as one statement's guard compares them. */
const COUNTS =
  "(SELECT count(*) FROM floor_codes c WHERE c.host_id = s.host_id AND c.device_id = s.device_id " +
  "AND c.shift_id = s.id) AS actual, " +
  "(SELECT count(*) FROM floor_boxes b WHERE b.host_id = s.host_id AND b.device_id = s.device_id " +
  "AND b.shift_id = s.id AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS closed";

/**
 * Reads the summary of the shift's close: the plan from this station's copy
 * now, the actual quantity and the closed boxes from its own records, and
 * what keeps it from closing. Every label is counted, not read: a waiting
 * job this build cannot read still keeps the shift open.
 */
export async function readCloseSummary(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<CloseSummary> {
  const copy = await readShiftCopy(local, pairing, shiftId);
  const [row] = await local.query(
    `SELECT s.local_state, ${COUNTS}, ` +
      "(SELECT coalesce(sum(b.item_count), 0) FROM floor_boxes b WHERE b.host_id = s.host_id " +
      "AND b.device_id = s.device_id AND b.shift_id = s.id AND b.closed_at IS NULL) AS open_items, " +
      "(SELECT count(*) FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
      `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL}) AS waiting ` +
      "FROM floor_shifts s WHERE s.host_id = ? AND s.device_id = ? AND s.id = ?",
    [pairing.hostId, pairing.deviceId, shiftId],
    summaryRow,
  );
  if (copy === null || row === undefined) {
    return {
      plannedQty: null,
      actualQty: 0,
      closedBoxes: 0,
      reasonRequired: false,
      blocker: { kind: "closed" },
    };
  }
  const blocker: CloseBlocker | null =
    row.local_state !== null
      ? { kind: "closed" }
      : row.open_items > 0
        ? { kind: "open_box", items: row.open_items }
        : row.waiting > 0
          ? { kind: "label" }
          : null;
  return {
    plannedQty: copy.plannedQty,
    actualQty: row.actual,
    closedBoxes: row.closed,
    reasonRequired: shiftCloseReasonRequired(copy.plannedQty, row.actual),
    blocker,
  };
}

/**
 * How a close went: closed, with the record it wrote; kept open by a
 * blocker; a reason needed and not given; or `stale` — a scan, a box or a
 * label changed the shift between the summary and the write, nothing was
 * written, and the summary is read again.
 */
export type CloseResult =
  | { kind: "closed"; record: ShiftClosedFact }
  | { kind: "blocked"; blocker: CloseBlocker }
  | { kind: "reason_required" }
  | { kind: "stale" };

/**
 * Closes the shift on this station (stage 2a spec, decision 17 and
 * §5.7.7): the local write is the point of no return — it needs neither the
 * host nor the link, and the shift never opens again on this station. In
 * ONE transaction, after the extra `guards` (the pallets' plan's): the
 * shift's empty open box goes; its `shift_closed` record — the plan it saw,
 * the codes it holds, its closed boxes, the reason, the moment — goes into
 * the outbox as the shift's last record; and the shift is marked `closing`,
 * but only while nothing changed since the summary: the plan is the one
 * read, no label waits, no open box is left (what the first statement did
 * not remove holds codes), and the counts of codes and closed boxes are the
 * same (a code scanned, taken out or freed since changes them). From then on
 * the shift takes no record (`outboxStatement`). The receipt `accepted` of
 * the record makes it `closed` (`sendFactBatch`).
 *
 * The caller runs this as ONE queued, tracked job of the work screen (plan
 * 2a5 N9, 2a6 N13): a scan queued before it lands first and is counted (or
 * makes the close `stale`), and one queued after it must see the `closed` stop
 * before it reaches `processScan`. The summary is read apart from the write,
 * which is safe because the write re-checks it, but the queue is what keeps
 * an in-flight scan from surfacing as a raw `changes_mismatch` system error.
 * The caller therefore:
 * (a) sends `closeShift` through the work queue and `track`;
 * (b) makes a scan or an exception queued behind it check the `closed` stop
 *     first, or it fails with `changes_mismatch` from the guard;
 * (c) re-reads the summary when the write throws (the answer may be lost after
 *     the commit): `blocked` with `closed` after a press means closed, so it
 *     shows the `closed` stop, not an error;
 * (d) re-reads and re-shows the summary on `stale`, keeping the reason chosen
 *     only while the plan still needs one.
 */
export async function closeShift(
  context: BoxContext,
  reasonCode: ShiftCloseReasonCode | null,
  guards: readonly LocalStatement[] = [],
): Promise<CloseResult> {
  const { local, pairing, shift } = context;
  const summary = await readCloseSummary(local, pairing, shift.copy.id);
  if (summary.blocker !== null) return { kind: "blocked", blocker: summary.blocker };
  if (reasonCode !== null && !isShiftCloseReasonCode(reasonCode)) {
    return { kind: "reason_required" };
  }
  if (summary.reasonRequired && reasonCode === null) return { kind: "reason_required" };
  const closedAt = context.now().toISOString();
  const data: ShiftClosedFact = {
    plannedQtySnapshot: summary.plannedQty,
    actualQty: summary.actualQty,
    closedBoxCount: summary.closedBoxes,
    reasonCode,
    closedAt,
  };
  const record = shiftClosedRecord(
    { id: context.newId(), shiftId: shift.copy.id, operatorId: context.operatorId },
    data,
  );
  const scope = [pairing.hostId, pairing.deviceId, shift.copy.id];
  try {
    await local.transaction([
      ...guards,
      {
        sql:
          "DELETE FROM floor_boxes WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
          "AND closed_at IS NULL AND item_count = 0",
        values: scope,
      },
      outboxStatement(record, pairing, closedAt),
      {
        sql:
          "UPDATE floor_shifts AS s SET local_state = 'closing' WHERE s.host_id = ? " +
          "AND s.device_id = ? AND s.id = ? AND s.local_state IS NULL AND s.planned_qty IS ? " +
          "AND NOT EXISTS (SELECT 1 FROM floor_boxes o WHERE o.host_id = s.host_id " +
          "AND o.device_id = s.device_id AND o.shift_id = s.id AND o.closed_at IS NULL) " +
          "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
          `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL}) ` +
          "AND (SELECT count(*) FROM floor_codes c WHERE c.host_id = s.host_id " +
          "AND c.device_id = s.device_id AND c.shift_id = s.id) = ? " +
          "AND (SELECT count(*) FROM floor_boxes b WHERE b.host_id = s.host_id " +
          "AND b.device_id = s.device_id AND b.shift_id = s.id AND b.closed_at IS NOT NULL " +
          "AND b.disassembled_at IS NULL) = ?",
        values: [...scope, summary.plannedQty, summary.actualQty, summary.closedBoxes],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch")
      return { kind: "stale" };
    throw error;
  }
  return { kind: "closed", record: data };
}

const refusalRow = z.object({ shift_id: z.string(), code: z.string().nullable() });

/**
 * The shifts of this pairing whose close the host refused, with the code of
 * the refusal (`null` — none given). A refused record is refused for good
 * (plan 2a2): the shift stays `closing` on this station, and the office
 * closes it on the host.
 */
export async function readRefusedCloses(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<Map<string, string | null>> {
  const rows = await local.query(
    "SELECT shift_id, outcome_code AS code FROM outbox WHERE host_id = ? AND device_id = ? " +
      "AND kind = 'shift_closed' AND outcome = 'rejected' ORDER BY seq",
    [pairing.hostId, pairing.deviceId],
    refusalRow,
  );
  return new Map(rows.map((row) => [row.shift_id, row.code]));
}
