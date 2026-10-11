import type { LabelTemplateSpec } from "@markiro/domain";
import { z } from "zod";

import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  DISASSEMBLE_REASONS,
  MAX_REASON_TEXT_CHARS,
  OTHER_REASON,
  REPRINT_REASONS,
  type DisassembleReason,
  type ReprintReason,
} from "../exception-reasons.js";
import { exceptionStatements } from "../facts.js";
import {
  isOpenJob,
  prepareLabelJob,
  readPrintJob,
  sendLabelJob,
  StaleJobError,
  type PrintJob,
  type RenderLabel,
} from "../print/print-jobs.js";
import type { ResolveContext } from "../print/print-resolution.js";
import type { WorkstationSettings } from "../setup/workstation-settings.js";
import type { BoxContext } from "../work/box-close.js";
import { readOpenBox } from "../work/work-reads.js";

/*
 * Every function of this module writes a box of the shift, so every call must
 * run inside the work screen's queue and be handed to `track` before it
 * starts (plan 2a6, N13): the box digest and the open box are read separately
 * from the write, and a net-zero pair of writers (an undo and a scan) between
 * the two reads is ruled out only because all box writers are in that one
 * queue. The comparisons inside each transaction are the backstop, not the
 * rule.
 */

/** The words of a reason that cannot be kept: too long, or with a control character. */
export class InvalidReasonError extends Error {
  constructor() {
    super("the words of the reason cannot be kept");
    this.name = "InvalidReasonError";
  }
}

const CONTROL = /\p{Cc}/u;

/**
 * The words of the reason `other` as the host keeps them
 * (`validate::exception_reason_text`): trimmed, at most 200 code points, no
 * control character, so no line break. Nothing but blanks — no words
 * (`null`); words the host would refuse are refused here, before anything is
 * written, so a record of this station is never refused for them.
 */
export function reasonWords(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if ([...trimmed].length > MAX_REASON_TEXT_CHARS || CONTROL.test(trimmed)) {
    throw new InvalidReasonError();
  }
  return trimmed;
}

/** A reason of a reprint or a disassembly: a code of its kind's list, and words only with `other`. */
export interface ExceptionReason<Code extends string> {
  code: Code;
  text: string | null;
}

/** The checked reason fields of a record: the code, and its words or `null`. */
function reasonFields(
  reasons: readonly string[],
  reason: ExceptionReason<string>,
): { reasonCode: string; reasonText: string | null } {
  if (!reasons.includes(reason.code)) throw new InvalidReasonError();
  const words = reasonWords(reason.text);
  if (words !== null && reason.code !== OTHER_REASON) throw new InvalidReasonError();
  return { reasonCode: reason.code, reasonText: words };
}

/** Runs the write; a comparison that no longer holds is `stale` (nothing was written). */
async function commit(
  local: LocalExecutor,
  statements: readonly LocalStatement[],
): Promise<"done" | "stale"> {
  try {
    await local.transaction(statements);
    return "done";
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") return "stale";
    throw error;
  }
}

/**
 * How an exception on the open box went: done, with the box and what is left
 * in it; `empty` — no open box, or one without a code, and nothing written;
 * `stale` — the box changed between the read and the write, nothing was
 * written, and the operator may simply try again.
 */
export type OpenBoxResult =
  { kind: "done"; boxId: string; itemCount: number } | { kind: "empty" } | { kind: "stale" };

const lastCodeRow = z.object({
  code_hash: z.string(),
  scan_id: z.string(),
  scanned_at: z.string(),
});

/** The code accepted last into a box: the newest row of `floor_codes` (pinned in the query-plan list). */
export const LAST_CODE_SQL =
  "SELECT code_hash, scan_id, scanned_at FROM floor_codes " +
  "WHERE host_id = ? AND device_id = ? AND box_id = ? ORDER BY rowid DESC LIMIT 1";

/**
 * «Снять последний код» (stage 2a spec §5.7.6): the code accepted last into
 * the shift's open box — the latest row of `floor_codes` (a row's rowid
 * grows with every insert, the order the codes were accepted in, whatever
 * the clock did) — leaves the box in ONE transaction: its place in
 * `floor_codes` (the code is free again, as the host frees it from its
 * registry: nobody owns it until the next scan), one less in the box (only
 * while the box is open and holds what was read: a scan or a close that
 * landed meanwhile makes it `stale`), the station's exception and the `undo`
 * record. The row deleted must be the very row read (code and scan): a scan
 * and an undo that cancelled out in the count, with another code now last,
 * make it `stale` too. The record names the code and the exact instant of
 * its scan as `floor_codes` keeps it — the same text as the scan's record —
 * because the host takes out only the item of that code added at that
 * instant (plan 2a2): an undo that arrives late, or is sent again under a
 * new id, never takes out a later scan of the code.
 */
export async function undoLastCode(context: BoxContext): Promise<OpenBoxResult> {
  const { local, pairing, shift } = context;
  const box = await readOpenBox(local, pairing, shift.copy.id);
  if (box === null || box.itemCount === 0) return { kind: "empty" };
  const [last] = await local.query(
    LAST_CODE_SQL,
    [pairing.hostId, pairing.deviceId, box.id],
    lastCodeRow,
  );
  if (last === undefined) return { kind: "empty" };
  const at = context.now().toISOString();
  const written = await commit(local, [
    {
      sql:
        "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND code_hash = ? " +
        "AND scan_id = ? AND box_id = ?",
      values: [pairing.hostId, pairing.deviceId, last.code_hash, last.scan_id, box.id],
      expectedChanges: 1,
    },
    {
      sql:
        "UPDATE floor_boxes SET item_count = item_count - 1 WHERE id = ? AND host_id = ? " +
        "AND device_id = ? AND closed_at IS NULL AND item_count = ?",
      values: [box.id, pairing.hostId, pairing.deviceId, box.itemCount],
      expectedChanges: 1,
    },
    ...exceptionStatements(context, shift.copy.id, {
      exception: "undo",
      boxId: box.id,
      codeHash: last.code_hash,
      targetScannedAt: last.scanned_at,
      reasonCode: null,
      reasonText: null,
      occurredAt: at,
    }),
  ]);
  return written === "stale"
    ? { kind: "stale" }
    : { kind: "done", boxId: box.id, itemCount: box.itemCount - 1 };
}

const newestScanRow = z.object({ scanned_at: z.string().nullable() });

/** The newest scan among a box's codes (pinned in the query-plan list). */
export const NEWEST_CODE_SCAN_SQL =
  "SELECT max(scanned_at) AS scanned_at FROM floor_codes " +
  "WHERE host_id = ? AND device_id = ? AND box_id = ?";

/**
 * «Очистить короб» (stage 2a spec §5.7.6): every code of the shift's open box
 * leaves it in ONE transaction — their places in `floor_codes` (each code is
 * free again), the box emptied (only while it is open and holds what was
 * read), the station's exception and the `clear` record.
 * The box stays open, and the next code goes into it. The record's
 * `occurredAt` is the moment of the clear — never earlier than the newest
 * code it takes out: the host takes out the items added up to it, so a clock
 * that went back since a scan (a correction of the computer's time) must not
 * leave that scan's item in the host's box while the station's is empty.
 */
export async function clearOpenBox(context: BoxContext): Promise<OpenBoxResult> {
  const { local, pairing, shift } = context;
  const box = await readOpenBox(local, pairing, shift.copy.id);
  if (box === null || box.itemCount === 0) return { kind: "empty" };
  const [newest] = await local.query(
    NEWEST_CODE_SCAN_SQL,
    [pairing.hostId, pairing.deviceId, box.id],
    newestScanRow,
  );
  const now = context.now().toISOString();
  const latestScan = newest?.scanned_at ?? null;
  const at = latestScan !== null && latestScan > now ? latestScan : now;
  const written = await commit(local, [
    {
      sql: "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND box_id = ?",
      values: [pairing.hostId, pairing.deviceId, box.id],
    },
    {
      sql:
        "UPDATE floor_boxes SET item_count = 0 WHERE id = ? AND host_id = ? AND device_id = ? " +
        "AND closed_at IS NULL AND item_count = ?",
      values: [box.id, pairing.hostId, pairing.deviceId, box.itemCount],
      expectedChanges: 1,
    },
    ...exceptionStatements(context, shift.copy.id, {
      exception: "clear",
      boxId: box.id,
      codeHash: null,
      targetScannedAt: null,
      reasonCode: null,
      reasonText: null,
      occurredAt: at,
    }),
  ]);
  return written === "stale" ? { kind: "stale" } : { kind: "done", boxId: box.id, itemCount: 0 };
}

/** A closed box of the shift, as the exceptions list it. */
export interface ClosedBox {
  id: string;
  sscc: string;
  itemCount: number;
  closedAt: string;
}

const closedBoxRow = z.object({
  id: z.string(),
  sscc: z.string(),
  item_count: z.number().int().nonnegative(),
  closed_at: z.string(),
});

/** The shift's closed boxes not taken apart, the box closed last first (pinned in the query-plan list). */
export const CLOSED_BOXES_SQL =
  "SELECT id, sscc, item_count, closed_at FROM floor_boxes WHERE host_id = ? AND device_id = ? " +
  "AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL " +
  "ORDER BY closed_at DESC, serial DESC";

/**
 * The shift's closed boxes not taken apart, the box closed last first: what
 * a reprint or a disassembly can be done to.
 */
export async function readClosedBoxes(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<ClosedBox[]> {
  const rows = await local.query(
    CLOSED_BOXES_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    closedBoxRow,
  );
  return rows.map((row) => ({
    id: row.id,
    sscc: row.sscc,
    itemCount: row.item_count,
    closedAt: row.closed_at,
  }));
}

/** The box is no closed box of this shift that is not taken apart: nothing was written. */
export class BoxUnavailableError extends Error {
  constructor(boxId: string) {
    super(`box ${boxId} is not a closed box of the shift`);
    this.name = "BoxUnavailableError";
  }
}

const boxStateRow = z.object({
  closed_at: z.string().nullable(),
  disassembled_at: z.string().nullable(),
  codes: z.number().int().nonnegative(),
});

/** A box of the pairing and the shift, with its codes counted (pinned in the query-plan list). */
export const BOX_STATE_SQL =
  "SELECT closed_at, disassembled_at, (SELECT count(*) FROM floor_codes c " +
  "WHERE c.host_id = b.host_id AND c.device_id = b.device_id AND c.box_id = b.id) AS codes " +
  "FROM floor_boxes b WHERE b.id = ? AND b.host_id = ? AND b.device_id = ? AND b.shift_id = ?";

/** The box `boxId` of the pairing's shift when it is closed and not taken apart, with its codes counted. */
async function readLiveClosedBox(
  context: Pick<BoxContext, "local" | "pairing" | "shift">,
  boxId: string,
): Promise<{ codes: number } | null> {
  const { local, pairing, shift } = context;
  const [row] = await local.query(
    BOX_STATE_SQL,
    [boxId, pairing.hostId, pairing.deviceId, shift.copy.id],
    boxStateRow,
  );
  if (row === undefined || row.closed_at === null || row.disassembled_at !== null) return null;
  return { codes: row.codes };
}

/**
 * «Расформировать короб» (stage 2a spec §5.7.6): a closed box of the shift is
 * taken apart in ONE transaction — `disassembled_at` (only while it is closed
 * and not taken apart), every code of it out of `floor_codes` (each is free
 * again and may be scanned into another box: no item of a box with a printed
 * SSCC stays live), the station's exception and the `disassemble` record with
 * its reason. The box keeps its SSCC: the number is spent and never goes on
 * another box. It no longer counts among the shift's closed boxes. `stale` —
 * the box changed meanwhile, nothing written; a box that is open, taken apart
 * or another shift's — `BoxUnavailableError`.
 */
export async function disassembleBox(
  context: BoxContext,
  boxId: string,
  reason: ExceptionReason<DisassembleReason>,
): Promise<{ kind: "done"; freed: number } | { kind: "stale" }> {
  const fields = reasonFields(DISASSEMBLE_REASONS, reason);
  const box = await readLiveClosedBox(context, boxId);
  if (box === null) throw new BoxUnavailableError(boxId);
  const { local, pairing, shift } = context;
  const at = context.now().toISOString();
  const written = await commit(local, [
    {
      sql:
        "UPDATE floor_boxes SET disassembled_at = ? WHERE id = ? AND host_id = ? AND device_id = ? " +
        "AND closed_at IS NOT NULL AND disassembled_at IS NULL",
      values: [at, boxId, pairing.hostId, pairing.deviceId],
      expectedChanges: 1,
    },
    {
      sql: "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND box_id = ?",
      values: [pairing.hostId, pairing.deviceId, boxId],
    },
    ...exceptionStatements(context, shift.copy.id, {
      exception: "disassemble",
      boxId,
      codeHash: null,
      targetScannedAt: null,
      ...fields,
      occurredAt: at,
    }),
  ]);
  return written === "stale" ? { kind: "stale" } : { kind: "done", freed: box.codes };
}

/** The box's label still waits (its print job): the work screen decides it first. */
export class LabelWaitingError extends Error {
  constructor(boxId: string) {
    super(`the label of box ${boxId} still waits`);
    this.name = "LabelWaitingError";
  }
}

/**
 * The box's label was made from another revision of the template than the
 * shift holds now (the shift was entered again with a newer template): a
 * reprint here would print another label than the one on the box, so
 * nothing is written. Not a box that is missing — the operator is told so.
 */
export class TemplateChangedError extends Error {
  constructor(boxId: string) {
    super(`the label of box ${boxId} was made from another revision of the template`);
    this.name = "TemplateChangedError";
  }
}

const lastJobRow = z.object({ id: z.string() });

/**
 * The newest print job of a box of the shift (pinned in the query-plan list):
 * by insertion order (the rowid), not by `created_at`, which a corrected clock
 * of the computer can put out of order — as the last code of an undo is.
 */
export const LAST_BOX_JOB_SQL =
  "SELECT id FROM floor_print_jobs WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
  "AND purpose = 'box' AND subject_id = ? ORDER BY rowid DESC LIMIT 1";

/** What a reprint needs: the decisions' context, the shift and its snapshot. */
export type ReprintContext = ResolveContext & Pick<BoxContext, "shift">;

/**
 * The comparisons of a reprint's transaction: the box is still closed and
 * not taken apart, and its newest job is still the one read, with no job
 * after it (a disassembly or another reprint that landed between the read
 * and the write makes the write `stale`, whatever the order of the queue).
 * Both are no-op updates that count a row. A decided job never changes
 * (`sent` without a check, `verified`, `skipped` are final), so the job is
 * compared by its place among the box's jobs, not by its state.
 */
function reprintGuards(context: ReprintContext, boxId: string, last: PrintJob): LocalStatement[] {
  const { pairing, shift } = context;
  return [
    {
      sql:
        "UPDATE floor_boxes SET disassembled_at = disassembled_at WHERE id = ? AND host_id = ? " +
        "AND device_id = ? AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL",
      values: [boxId, pairing.hostId, pairing.deviceId, shift.copy.id],
      expectedChanges: 1,
    },
    {
      sql:
        "UPDATE floor_print_jobs SET state = state WHERE host_id = ? AND device_id = ? AND id = ? " +
        "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs newer WHERE newer.host_id = ? " +
        "AND newer.device_id = ? AND newer.shift_id = ? AND newer.purpose = 'box' " +
        "AND newer.subject_id = ? AND newer.rowid > (SELECT rowid FROM floor_print_jobs WHERE id = ?))",
      values: [
        pairing.hostId,
        pairing.deviceId,
        last.id,
        pairing.hostId,
        pairing.deviceId,
        shift.copy.id,
        boxId,
        last.id,
      ],
      expectedChanges: 1,
    },
  ];
}

/**
 * «Перепечатать этикетку» of a closed box whose label is done with (stage
 * 2a spec §5.7.6; plan 2a7's contract): a new print job of the same label —
 * the SSCC and the fields of the box's last job, the shift snapshot's
 * template of the job's own revision, the printer of the purpose «Короб» now
 * — is written in ONE transaction with the station's exception and the
 * `reprint` record and its reason (the one writer, `exceptionStatements`, the
 * same as the reprint of a label that waits, `printAgain`), so the office
 * sees that the box may carry two labels of one SSCC and the row is there
 * before a byte goes; then the job goes to the printer once, as a first send.
 * A box whose label still waits is decided at the label's panel
 * (`LabelWaitingError`); a box open, taken apart or another shift's, or one
 * without a job, or whose job was made from another revision of the template
 * than the snapshot now holds — `BoxUnavailableError`, and for the template
 * `TemplateChangedError`. A box taken apart or
 * a reprint that landed after the read — `BoxUnavailableError` or
 * `StaleJobError`, nothing written. No printer or no render: the job is kept
 * `failed` and the label's panel takes it from there. Answers the new job.
 *
 * Known limit (accepted, plan 2a7): the exception does not name the printer
 * the first label came out on.
 */
export async function reprintBox(
  context: ReprintContext,
  boxId: string,
  reason: ExceptionReason<ReprintReason>,
  settings: Pick<WorkstationSettings, "printers" | "assignments" | "verifyPrintedLabel">,
  render?: RenderLabel,
): Promise<PrintJob> {
  const fields = reasonFields(REPRINT_REASONS, reason);
  const { local, pairing, shift } = context;
  if ((await readLiveClosedBox(context, boxId)) === null) throw new BoxUnavailableError(boxId);
  const [row] = await local.query(
    LAST_BOX_JOB_SQL,
    [pairing.hostId, pairing.deviceId, shift.copy.id, boxId],
    lastJobRow,
  );
  const last = row === undefined ? null : await readPrintJob(local, pairing, row.id);
  if (last === null) throw new BoxUnavailableError(boxId);
  if (isOpenJob(last)) throw new LabelWaitingError(boxId);
  const { boxTemplate } = shift.snapshot;
  if (boxTemplate.id !== last.templateId || boxTemplate.rev !== last.templateRev) {
    throw new TemplateChangedError(boxId);
  }
  const template: { id: string; rev: number; spec: LabelTemplateSpec } = {
    id: boxTemplate.id,
    rev: boxTemplate.rev,
    spec: boxTemplate.spec,
  };
  const at = context.now().toISOString();
  const jobId = context.newId();
  const job = await prepareLabelJob(
    {
      id: jobId,
      shiftId: shift.copy.id,
      purpose: "box",
      subjectId: boxId,
      sscc: last.sscc,
      fields: last.fields,
      template,
      operatorId: context.operatorId,
      createdAt: at,
    },
    settings,
    pairing,
    render,
  );
  const written = await commit(local, [
    ...reprintGuards(context, boxId, last),
    job,
    ...exceptionStatements(context, shift.copy.id, {
      exception: "reprint",
      boxId,
      codeHash: null,
      targetScannedAt: null,
      ...fields,
      occurredAt: at,
    }),
  ]);
  if (written === "stale") {
    // The box was taken apart meanwhile, or another reprint landed.
    if ((await readLiveClosedBox(context, boxId)) === null) throw new BoxUnavailableError(boxId);
    throw new StaleJobError(last.id);
  }
  const kept = await readPrintJob(local, pairing, jobId);
  if (kept === null) throw new BoxUnavailableError(boxId);
  return kept.state === "prepared" ? sendLabelJob(context, kept) : kept;
}
