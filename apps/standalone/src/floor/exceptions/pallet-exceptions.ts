import { z } from "zod";

import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  DISASSEMBLE_REASONS,
  REPRINT_REASONS,
  type DisassembleReason,
  type ReprintReason,
} from "../exception-reasons.js";
import { palletExceptionStatements } from "../facts.js";
import { LIVE_BOXES, palletLiveGuard, type ShiftPallets } from "../pallets/pallets.js";
import {
  isOpenJob,
  prepareLabelJob,
  readPrintJob,
  sendLabelJob,
  StaleJobError,
  type PrintJob,
  type RenderLabel,
} from "../print/print-jobs.js";
import type { WorkstationSettings } from "../setup/workstation-settings.js";
import type { BoxContext } from "../work/box-close.js";
import {
  LabelWaitingError,
  reasonFields,
  type ExceptionReason,
  type ReprintContext,
} from "./box-exceptions.js";

// The one writer of a pallet's exception rows, kept in `facts.ts` beside the box's.
export { palletExceptionStatements };

/*
 * As the box exceptions (`box-exceptions.ts`), every function of this module
 * writes a pallet of the shift, so every call must run inside the work
 * screen's queue and be handed to `track` before it starts (plan 2a6, N13):
 * the pallet and its newest label are read separately from the write. The
 * comparisons inside each transaction are the backstop, not the rule.
 *
 * A pallet's label is never sent again by itself. The one reprint here is
 * written with its reason in the transaction that records the new job, and
 * goes to the printer once, as a first send; and nothing at all is recorded
 * of a pallet after it was taken apart (the host answers `pallet_state` to
 * such a record, and a refusal stays in the queue for good).
 */

/** A closed pallet of the shift, as the exceptions list it. */
export interface ClosedPallet {
  id: string;
  sscc: string;
  /** Its boxes not taken apart. */
  boxCount: number;
  closedAt: string;
}

const closedPalletRow = z.object({
  id: z.string(),
  sscc: z.string(),
  boxes: z.number().int().nonnegative(),
  closed_at: z.string(),
});

/**
 * The shift's closed pallets not taken apart with their live boxes counted,
 * the pallet closed last first (pinned in both lists of query plans: the
 * shift's pallets, the boxes through `floor_boxes_pallet`, one sort for the
 * few pallets of a shift).
 */
export const CLOSED_PALLETS_SQL =
  `SELECT p.id, p.sscc, p.closed_at, (SELECT count(*) ${LIVE_BOXES}) AS boxes FROM floor_pallets p ` +
  "WHERE p.host_id = ? AND p.device_id = ? AND p.shift_id = ? AND p.closed_at IS NOT NULL " +
  "AND p.disassembled_at IS NULL ORDER BY p.closed_at DESC, p.serial DESC";

/**
 * The shift's closed pallets not taken apart, the pallet closed last first:
 * what a pallet's reprint or disassembly can be done to.
 */
export async function readClosedPallets(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<ClosedPallet[]> {
  const rows = await local.query(
    CLOSED_PALLETS_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    closedPalletRow,
  );
  return rows.map((row) => ({
    id: row.id,
    sscc: row.sscc,
    boxCount: row.boxes,
    closedAt: row.closed_at,
  }));
}

/** The pallet is no closed pallet of this shift that is not taken apart: nothing was written. */
export class PalletUnavailableError extends Error {
  constructor(
    palletId: string,
    message = `pallet ${palletId} is not a closed pallet of the shift`,
  ) {
    super(message);
    this.name = "PalletUnavailableError";
  }
}

/**
 * The pallet's label was made from another revision of the template than the
 * shift holds now (the shift was entered again with a newer one): a reprint
 * would print another label than the one on the pallet, so nothing is
 * written. A `PalletUnavailableError`, so a caller that does not tell the two
 * apart refuses it as well.
 */
export class PalletTemplateChangedError extends PalletUnavailableError {
  constructor(palletId: string) {
    super(
      palletId,
      `the label of pallet ${palletId} was made from another revision of the template`,
    );
    this.name = "PalletTemplateChangedError";
  }
}

const palletStateRow = z.object({
  closed_at: z.string().nullable(),
  disassembled_at: z.string().nullable(),
  boxes: z.number().int().nonnegative(),
});

/** A pallet of the pairing and the shift with its live boxes counted (pinned in both lists of query plans). */
export const PALLET_STATE_SQL =
  `SELECT p.closed_at, p.disassembled_at, (SELECT count(*) ${LIVE_BOXES}) AS boxes ` +
  "FROM floor_pallets p WHERE p.id = ? AND p.host_id = ? AND p.device_id = ? AND p.shift_id = ?";

/** The boxes a pallet holds when it is a closed pallet of the shift not taken apart, or `null`. */
async function readLiveClosedPallet(
  context: Pick<BoxContext, "local" | "pairing" | "shift">,
  palletId: string,
): Promise<{ boxes: number } | null> {
  const { local, pairing, shift } = context;
  const [row] = await local.query(
    PALLET_STATE_SQL,
    [palletId, pairing.hostId, pairing.deviceId, shift.copy.id],
    palletStateRow,
  );
  if (row === undefined || row.closed_at === null || row.disassembled_at !== null) return null;
  return { boxes: row.boxes };
}

/**
 * The pallet's disassembly (pinned in both lists of query plans): only while
 * it is closed and not taken apart, so of two disassemblies one wins.
 */
export const DISASSEMBLE_PALLET_SQL =
  "UPDATE floor_pallets SET disassembled_at = ? WHERE id = ? AND host_id = ? AND device_id = ? " +
  "AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL";

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
 * «Расформировать паллету» (pilot spec §6.1): a closed pallet of the shift
 * is taken apart in ONE transaction — `disassembled_at` (only while it is
 * closed and not taken apart), the station's exception and the
 * `disassemble` record with its reason, which is required. Its boxes are
 * untouched and keep their pallet, as in the cloud: for the exports they are
 * boxes without a pallet (plan ПЛ-Х), and they stay closed, with their
 * codes. The pallet keeps its SSCC: the number is spent. `stale` — the pallet
 * changed meanwhile, nothing written; one that is open, taken apart or
 * another shift's — `PalletUnavailableError`. The act cannot be undone: the
 * work screen asks to confirm it before it calls this.
 */
export async function disassemblePallet(
  context: BoxContext,
  palletId: string,
  reason: ExceptionReason<DisassembleReason>,
): Promise<{ kind: "done"; boxes: number } | { kind: "stale" }> {
  const fields = reasonFields(DISASSEMBLE_REASONS, reason);
  const pallet = await readLiveClosedPallet(context, palletId);
  if (pallet === null) throw new PalletUnavailableError(palletId);
  const { local, pairing, shift } = context;
  const at = context.now().toISOString();
  const written = await commit(local, [
    {
      sql: DISASSEMBLE_PALLET_SQL,
      values: [at, palletId, pairing.hostId, pairing.deviceId, shift.copy.id],
      expectedChanges: 1,
    },
    ...palletExceptionStatements(context, shift.copy.id, {
      exception: "disassemble",
      palletId,
      reasonCode: fields.reasonCode,
      reasonText: fields.reasonText,
      occurredAt: at,
    }),
  ]);
  return written === "stale" ? { kind: "stale" } : { kind: "done", boxes: pallet.boxes };
}

const lastJobRow = z.object({ id: z.string() });

/**
 * The newest print job of a pallet of the shift (pinned in both lists of query
 * plans): by insertion order (the rowid), not by `created_at`, which a
 * corrected clock of the computer can put out of order.
 */
export const LAST_PALLET_JOB_SQL =
  "SELECT id FROM floor_print_jobs WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
  "AND purpose = 'pallet' AND subject_id = ? ORDER BY rowid DESC LIMIT 1";

/**
 * The comparison that keeps two reprints from both passing (pinned in both
 * lists of query plans): the job read is still the pallet's newest, with no
 * job after it. A decided job never changes, so it is compared by its place
 * among the pallet's jobs, not by its state.
 */
export const NEWEST_PALLET_JOB_GUARD_SQL =
  "UPDATE floor_print_jobs SET state = state WHERE host_id = ? AND device_id = ? AND id = ? " +
  "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs newer WHERE newer.host_id = ? " +
  "AND newer.device_id = ? AND newer.shift_id = ? AND newer.purpose = 'pallet' " +
  "AND newer.subject_id = ? AND newer.rowid > (SELECT rowid FROM floor_print_jobs WHERE id = ?))";

/**
 * «Перепечатать этикетку паллеты» of a closed pallet whose label is done with
 * (pilot spec §6.1; plan 2a8's contract): a new print job of the same label —
 * the SSCC and the fields of the pallet's last job, so the dates are those of
 * its own close, the snapshot's pallet template of the job's revision, the
 * printer of the purpose «Паллета» now — written in ONE transaction with the
 * station's exception and the `reprint` record and its reason, and with the
 * comparisons that the pallet is still closed and not taken apart and that
 * its newest job is still the one read; then the job goes to the printer
 * once, as a first send. A pallet whose label still waits is decided at the
 * label's panel (`LabelWaitingError`); one open, taken apart, another
 * shift's or without a job — `PalletUnavailableError`, and for a template of
 * another revision `PalletTemplateChangedError`. A pallet taken apart or a
 * reprint that landed after the read — `PalletUnavailableError` or
 * `StaleJobError`, nothing written. No printer or no render: the job is kept
 * `failed`, and the label's panel takes it from there. Answers the new job.
 */
export async function reprintPallet(
  context: ReprintContext,
  pallets: ShiftPallets,
  palletId: string,
  reason: ExceptionReason<ReprintReason>,
  settings: Pick<WorkstationSettings, "printers" | "assignments" | "verifyPrintedLabel">,
  render?: RenderLabel,
): Promise<PrintJob> {
  const fields = reasonFields(REPRINT_REASONS, reason);
  const { local, pairing, shift } = context;
  if ((await readLiveClosedPallet(context, palletId)) === null) {
    throw new PalletUnavailableError(palletId);
  }
  const [row] = await local.query(
    LAST_PALLET_JOB_SQL,
    [pairing.hostId, pairing.deviceId, shift.copy.id, palletId],
    lastJobRow,
  );
  const last = row === undefined ? null : await readPrintJob(local, pairing, row.id);
  if (last === null) throw new PalletUnavailableError(palletId);
  if (isOpenJob(last)) throw new LabelWaitingError(palletId);
  const { template } = pallets;
  if (template.id !== last.templateId || template.rev !== last.templateRev) {
    throw new PalletTemplateChangedError(palletId);
  }
  const at = context.now().toISOString();
  const jobId = context.newId();
  const job = await prepareLabelJob(
    {
      id: jobId,
      shiftId: shift.copy.id,
      purpose: "pallet",
      subjectId: palletId,
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
    palletLiveGuard(pairing, shift.copy.id, palletId),
    {
      sql: NEWEST_PALLET_JOB_GUARD_SQL,
      values: [
        pairing.hostId,
        pairing.deviceId,
        last.id,
        pairing.hostId,
        pairing.deviceId,
        shift.copy.id,
        palletId,
        last.id,
      ],
      expectedChanges: 1,
    },
    job,
    ...palletExceptionStatements(context, shift.copy.id, {
      exception: "reprint",
      palletId,
      reasonCode: fields.reasonCode,
      reasonText: fields.reasonText,
      occurredAt: at,
    }),
  ]);
  if (written === "stale") {
    // The pallet was taken apart meanwhile, or another reprint landed.
    if ((await readLiveClosedPallet(context, palletId)) === null) {
      throw new PalletUnavailableError(palletId);
    }
    throw new StaleJobError(last.id);
  }
  const kept = await readPrintJob(local, pairing, jobId);
  if (kept === null) throw new PalletUnavailableError(palletId);
  return kept.state === "prepared" ? sendLabelJob(context, kept) : kept;
}
