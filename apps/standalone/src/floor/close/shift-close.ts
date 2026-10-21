import { isShiftCloseReasonCode, type ShiftCloseReasonCode } from "@markiro/domain";
import { z } from "zod";

import type { ShiftClosedFact } from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { outboxStatement, shiftClosedRecord } from "../facts.js";
import { LIVE_BOXES } from "../pallets/pallets.js";
import { OPEN_JOB_SQL } from "../print/print-jobs.js";
import { readShiftCopy } from "../shifts/shift-copies.js";
import {
  closesShift,
  participantsEver,
  readParticipation,
  sharedCount,
  sharedParticipation,
} from "../shifts/shift-participation.js";
import { UNRESOLVED_UNIT_LABEL_SQL } from "../unit-labels/unit-label-store.js";
import type { BoxContext } from "../work/box-close.js";
import { readLostCodes } from "../work/work-reads.js";
import { stationReasonRequired } from "./shared-reason.js";

/**
 * What keeps the shift from closing now (stage 2a spec §5.7.7): an open box
 * with codes, which the operator closes or clears first; a label of the
 * shift that still waits for the printer or the operator (plan 2a7's
 * `shiftLabelsSettled`: a label decided after the close would reach the host
 * after `shift_closed` and mark the station's own shift late); an open
 * pallet with boxes (plan ПЛ-Ц), which «Закрыть паллету и смену» closes
 * first; a unit label of the shift that is not resolved (plan РЕЖ part B,
 * the cloud station's `PRODUCT_LABEL_UNRESOLVED`: its outcome may be
 * unknown, and the retention keeps a shift with one); or this station has
 * closed it already.
 */
export type CloseBlocker =
  | { kind: "open_box"; items: number }
  | { kind: "label" }
  | { kind: "label_unresolved" }
  | { kind: "open_pallet"; boxes: number }
  | { kind: "closed" };

/** What a part's close of a shared shift does (plan 2b), as the station knows it. */
export interface PartClose {
  /** By the last read, no other participant stays active or left: this close closes the shift. */
  closesShift: boolean;
  /** The whole shift's count: the others' part by the host and this station's own codes. */
  total: number;
  /** The link was up when the summary was read: only then can a shared close ask for a reason. */
  online: boolean;
}

/** The summary of the close (the cloud's close summary), from this station's own records. */
export interface CloseSummary {
  /** The plan as this station's copy has it now: the record carries it as the plan it saw. */
  plannedQty: number | null;
  /** Codes this station holds in the shift, in its boxes or in none (a validation shift's): its actual quantity. */
  actualQty: number;
  /** The shift's closed boxes not taken apart. */
  closedBoxes: number;
  /** The plan is given and not met: one of the domain's six reasons is needed. */
  reasonRequired: boolean;
  blocker: CloseBlocker | null;
  /** A shift several devices may work (plan 2b): this station closes only its part. Absent: a solo shift. */
  part?: PartClose;
}

const summaryRow = z.object({
  local_state: z.string().nullable(),
  actual: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  open_items: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  pallet_boxes: z.number().int().nonnegative(),
});

/** The counts of the shift's codes and closed boxes, as one statement's guard compares them. */
const COUNTS =
  "(SELECT count(*) FROM floor_codes c WHERE c.host_id = s.host_id AND c.device_id = s.device_id " +
  "AND c.shift_id = s.id) AS actual, " +
  "(SELECT count(*) FROM floor_boxes b WHERE b.host_id = s.host_id AND b.device_id = s.device_id " +
  "AND b.shift_id = s.id AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS closed";

/**
 * The summary's one read; parameters: host id, device id, shift id. It runs
 * whenever the close panel opens or its inputs change, so its plan is pinned
 * in both lists of plans.
 */
export const CLOSE_SUMMARY_SQL =
  `SELECT s.local_state, ${COUNTS}, ` +
  "(SELECT coalesce(sum(b.item_count), 0) FROM floor_boxes b WHERE b.host_id = s.host_id " +
  "AND b.device_id = s.device_id AND b.shift_id = s.id AND b.closed_at IS NULL) AS open_items, " +
  "(SELECT count(*) FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
  `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL}) AS waiting, ` +
  `(SELECT coalesce(sum((SELECT count(*) ${LIVE_BOXES})), 0) FROM floor_pallets p ` +
  "WHERE p.host_id = s.host_id AND p.device_id = s.device_id AND p.shift_id = s.id " +
  "AND p.closed_at IS NULL) AS pallet_boxes " +
  "FROM floor_shifts s WHERE s.host_id = ? AND s.device_id = ? AND s.id = ?";

/**
 * The shift's unresolved unit label (plan РЕЖ part B): the pairing's one
 * unresolved job asked through its unique index, as the retention asks it
 * (`INDEXED BY`: the planner would walk the shift's every job through
 * `floor_unit_labels_shift`, one per accepted unit). Parameters: host id,
 * device id, shift id. Pinned with the summary in both lists of plans.
 */
export const SHIFT_UNRESOLVED_UNIT_LABEL_SQL =
  "SELECT count(*) AS n FROM floor_unit_labels INDEXED BY floor_unit_labels_unresolved " +
  `WHERE host_id = ? AND device_id = ? AND shift_id = ? AND ${UNRESOLVED_UNIT_LABEL_SQL}`;

/**
 * The close's own refusal of a shift with an unresolved unit label, as a term
 * of the statement that marks it `closing` (`s` — that shift), so a label
 * written after the summary was read keeps the shift open: nothing is
 * written, the close is `stale`, and the summary read again names the label.
 */
const UNIT_LABELS_SETTLED =
  "NOT EXISTS (SELECT 1 FROM floor_unit_labels u INDEXED BY floor_unit_labels_unresolved " +
  "WHERE u.host_id = s.host_id AND u.device_id = s.device_id AND u.shift_id = s.id " +
  `AND ${UNRESOLVED_UNIT_LABEL_SQL})`;

/**
 * The close's last statement: the shift marked `closing` only while the summary
 * it was read from still holds — no open box, no open print job, no unresolved
 * unit label, the same plan, codes and closed boxes. Parameters: host id,
 * device id, shift id, planned quantity, actual quantity, closed boxes. Pinned
 * with the unit label reads in both lists of plans.
 */
export const MARK_CLOSING_SQL =
  "UPDATE floor_shifts AS s SET local_state = 'closing' WHERE s.host_id = ? " +
  "AND s.device_id = ? AND s.id = ? AND s.local_state IS NULL AND s.planned_qty IS ? " +
  "AND NOT EXISTS (SELECT 1 FROM floor_boxes o WHERE o.host_id = s.host_id " +
  "AND o.device_id = s.device_id AND o.shift_id = s.id AND o.closed_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
  `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL}) ` +
  `AND ${UNIT_LABELS_SETTLED} ` +
  "AND (SELECT count(*) FROM floor_codes c WHERE c.host_id = s.host_id " +
  "AND c.device_id = s.device_id AND c.shift_id = s.id) = ? " +
  "AND (SELECT count(*) FROM floor_boxes b WHERE b.host_id = s.host_id " +
  "AND b.device_id = s.device_id AND b.shift_id = s.id AND b.closed_at IS NOT NULL " +
  "AND b.disassembled_at IS NULL) = ?";

const unresolvedRow = z.object({ n: z.number().int().nonnegative() });

/**
 * Reads the summary of the shift's close: the plan from this station's copy
 * now, the actual quantity and the closed boxes from its own records, and
 * what keeps it from closing. Every label is counted, not read: a waiting
 * job this build cannot read still keeps the shift open. An open pallet keeps
 * it open only while it holds a box not taken apart (plan ПЛ-Ц).
 *
 * Since plan 2b it also reads what the host's last read said of a shift several devices may work:
 * the part's close (`part`) — whether it closes the shift and the whole shift's count — and the
 * reason by `stationReasonRequired`, so a shared close asks it only online (`online`) of the last
 * closer.
 */
export async function readCloseSummary(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
  online: boolean,
): Promise<CloseSummary> {
  const copy = await readShiftCopy(local, pairing, shiftId);
  const [row] = await local.query(
    CLOSE_SUMMARY_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    summaryRow,
  );
  const [unresolved] = await local.query(
    SHIFT_UNRESOLVED_UNIT_LABEL_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    unresolvedRow,
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
          : (unresolved?.n ?? 0) > 0
            ? { kind: "label_unresolved" }
            : row.pallet_boxes > 0
              ? { kind: "open_pallet", boxes: row.pallet_boxes }
              : null;
  // Plan 2b: what the host's last read said of the shift; unreadable, the shift is a solo one.
  const participation = await readParticipation(local, pairing, shiftId).catch(() => null);
  const shared = sharedParticipation(participation);
  // The codes of this station the host counts for no one here (final review I2).
  const lost = shared === null ? 0 : await readLostCodes(local, pairing, shiftId).catch(() => 0);
  const part: PartClose | null =
    shared === null
      ? null
      : {
          closesShift: closesShift(shared, pairing.deviceId),
          total: sharedCount(shared, pairing.deviceId, row.actual, lost).total,
          online,
        };
  return {
    plannedQty: copy.plannedQty,
    actualQty: row.actual,
    closedBoxes: row.closed,
    reasonRequired: stationReasonRequired({
      plannedQty: copy.plannedQty,
      actualQty: row.actual,
      participantsEver: participantsEver(participation),
      closesShift: part?.closesShift ?? true,
      online,
      total: part?.total ?? row.actual,
    }),
    blocker,
    ...(part === null ? {} : { part }),
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
 * read, no label waits, no unit label of the shift is unresolved (plan РЕЖ
 * part B), no open box is left (what the first statement did
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
 *
 * `online` is the link's state for a shared shift's reason (plan 2b): the record is the same — it
 * closes this station's part — and the host closes the shift with the last part.
 */
export async function closeShift(
  context: BoxContext,
  reasonCode: ShiftCloseReasonCode | null,
  guards: readonly LocalStatement[],
  online: boolean,
): Promise<CloseResult> {
  const { local, pairing, shift } = context;
  const summary = await readCloseSummary(local, pairing, shift.copy.id, online);
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
        sql: MARK_CLOSING_SQL,
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
 * The reading of `readRefusedCloses`; parameters: host id, device id. It runs
 * on every bump of the outbox while the shift list is shown, so its plan is
 * pinned (`outbox_settled`, the pairing's refused records only) in both lists
 * of plans.
 */
export const REFUSED_CLOSES_SQL =
  "SELECT shift_id, outcome_code AS code FROM outbox WHERE host_id = ? AND device_id = ? " +
  "AND kind = 'shift_closed' AND outcome = 'rejected' AND resolved_at IS NULL ORDER BY seq";

/**
 * The shifts of this pairing whose close the host refused, with the code of
 * the refusal (`null` — none given). A refused record is refused for good
 * (plan 2a2): the shift stays `closing` on this station, and the office
 * closes it on the host. A refused close sent again from the queue screen
 * (plan ОЧ) is resolved and no longer named; its new record waits like any
 * other.
 */
export async function readRefusedCloses(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<Map<string, string | null>> {
  const rows = await local.query(
    REFUSED_CLOSES_SQL,
    [pairing.hostId, pairing.deviceId],
    refusalRow,
  );
  return new Map(rows.map((row) => [row.shift_id, row.code]));
}

/**
 * What became of this station's close of its part of a shared shift (plan 2b, host D8): the record
 * waits for the host (`queued`); the host closed the part and the shift waits for the others
 * (`waiting`); the shift is closed — by this record, by an earlier close, or later by the others
 * or the office (`shift_closed`); the shift closed without the reason it needed, which the office
 * gives (`reason_missing`); or the host refused the record (`refused`, the queue screen's to
 * resolve).
 */
export type PartState = "queued" | "waiting" | "shift_closed" | "reason_missing" | "refused";

/**
 * The shift's last `shift_closed` record of this pairing with its stored outcome and details
 * (`sendFactBatch` keeps both) and the copy's status by the last list. Parameters: shift id, host
 * id, device id. Searches `outbox_shift`.
 */
export const PART_STATE_SQL =
  "SELECT o.outcome AS outcome, o.outcome_details ->> 'partClosed' AS part_closed, " +
  "o.outcome_details ->> 'reasonMissing' AS reason_missing, s.status AS status FROM outbox o " +
  "JOIN floor_shifts s ON s.host_id = o.host_id AND s.device_id = o.device_id " +
  "AND s.id = o.shift_id WHERE o.shift_id = ? AND o.host_id = ? AND o.device_id = ? " +
  "AND o.kind = 'shift_closed' ORDER BY o.seq DESC LIMIT 1";

const partRow = z.object({
  outcome: z.string().nullable(),
  part_closed: z.number().nullable(),
  reason_missing: z.number().nullable(),
  status: z.string(),
});

/** The part's state; `null` when this station wrote no close of the shift. */
export async function readPartState(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<PartState | null> {
  const [row] = await local.query(
    PART_STATE_SQL,
    [shiftId, pairing.hostId, pairing.deviceId],
    partRow,
  );
  if (row === undefined) return null;
  if (row.outcome === null) return "queued";
  if (row.outcome !== "accepted") return "refused";
  if (row.reason_missing === 1) return "reason_missing";
  if (row.part_closed === 1) return row.status === "closed" ? "shift_closed" : "waiting";
  return "shift_closed";
}
