import { LABEL_FIELDS, type LabelTemplateSpec } from "@markiro/domain";
import { z } from "zod";

import { bytesToBase64 } from "../../hardware/hardware.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  parsePrinterProfile,
  readWorkstationSettings,
  resolvePrinter,
  type PrinterProfile,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import type { CloseStep } from "../work/box-close.js";
import { boxLabelData, renderLabel, type LabelFields, type LabelPrinter } from "./label-render.js";
import type { PrintRuntime, SendOutcome } from "./print-runtime.js";

/** What a label is for: a box, or a pallet of the pallets' plan (ПЛ-Ц). */
export const LABEL_PURPOSES = ["box", "pallet"] as const;
export type LabelPurpose = (typeof LABEL_PURPOSES)[number];

/** A print job's states (stage 2a spec, decision 19; migration `0007`). */
export const PRINT_JOB_STATES = [
  "prepared",
  "sending",
  "sent",
  "failed",
  "unknown",
  "verified",
  "skipped",
] as const;
export type PrintJobState = (typeof PRINT_JOB_STATES)[number];

/**
 * Why a job failed — nothing left this computer, so a new send cannot double
 * a label: no printer for the purpose, a label that would not render, the
 * shell's `not_sent`, `invalid_target`, `invalid_payload`, `unsupported`,
 * and `printer_busy` — the send's limit ran out while an earlier send to the
 * same address still had the printer.
 */
export const FAILED_CODES = [
  "printer_unconfigured",
  "render_failed",
  "not_sent",
  "invalid_target",
  "invalid_payload",
  "unsupported",
  "printer_busy",
] as const;
/**
 * Why a job's outcome is unknown — a label may exist: the shell's
 * `outcome_unknown`, no answer within the limit (`timeout`), and a job found
 * `sending` after a restart or a lost write (`interrupted`).
 */
export const UNKNOWN_CODES = ["outcome_unknown", "timeout", "interrupted"] as const;
export type FailedCode = (typeof FAILED_CODES)[number];
export type UnknownCode = (typeof UNKNOWN_CODES)[number];
export type PrintJobCode = FailedCode | UnknownCode;

/** A print job as stored, read for the current pairing. */
export interface PrintJob {
  id: string;
  shiftId: string;
  purpose: LabelPurpose;
  subjectId: string;
  sscc: string;
  state: PrintJobState;
  /** The label is checked by a scan of its SSCC once sent. */
  verify: boolean;
  templateId: string;
  templateRev: number;
  /** The label's fields, kept to render it again for another printer. */
  fields: LabelFields;
  /** The profile the bytes were rendered for; `null` — no printer was assigned. */
  printer: PrinterProfile | null;
  bytesBase64: string | null;
  errorCode: PrintJobCode | null;
  attempts: number;
  operatorId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A job that waits for the printer or for the operator: prepared, sending,
 * failed, unknown, or sent with a check not done yet. The next box does not
 * close while one waits (the unique index `floor_print_jobs_open` holds one
 * per label).
 */
export function isOpenJob(job: Pick<PrintJob, "state" | "verify">): boolean {
  return (
    job.state === "prepared" ||
    job.state === "sending" ||
    job.state === "failed" ||
    job.state === "unknown" ||
    (job.state === "sent" && job.verify)
  );
}

/**
 * The same rule in SQL, word for word the index's; plan 2a8's close of a
 * shift checks it in its own transaction.
 */
export const OPEN_JOB_SQL =
  "(state IN ('prepared', 'sending', 'failed', 'unknown') OR (state = 'sent' AND verify = 1))";

const COLUMNS =
  "id, shift_id, purpose, subject_id, sscc, state, verify, template_id, template_rev, " +
  "fields, printer, bytes_base64, error_code, attempts, operator_id, created_at, updated_at";

const jobRow = z.object({
  id: z.string(),
  shift_id: z.string(),
  purpose: z.enum(LABEL_PURPOSES),
  subject_id: z.string(),
  sscc: z.string(),
  state: z.enum(PRINT_JOB_STATES),
  verify: z.union([z.literal(0), z.literal(1)]),
  template_id: z.string(),
  template_rev: z.number().int(),
  fields: z.string(),
  printer: z.string().nullable(),
  bytes_base64: z.string().nullable(),
  error_code: z.enum([...FAILED_CODES, ...UNKNOWN_CODES]).nullable(),
  attempts: z.number().int(),
  operator_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** Every field of the domain, each a string: what `boxLabelData` gives. */
const fieldsSchema = z.record(z.enum(LABEL_FIELDS), z.string());

/**
 * A stored job this build cannot read: its printer profile or its fields are
 * damaged (a downgrade below a printer-profile format change, or a damaged
 * database).
 *
 * KNOWN LIMIT (an owner / plan 2b item, deliberately not worked around): every
 * read of such a job throws, so the work screen's line of that shift stays on
 * «Состояние этикетки не прочитано» until the operator leaves the shift, and
 * `shiftLabelsSettled` counts the row, so the shift cannot be closed locally.
 * Nothing is sent and nothing is lost, and another shift is not affected. The
 * way out, once decided, is a dedicated stop with one action, «Продолжить без
 * этикетки», carried out in SQL by the job id against the raw `state` and
 * `attempts` columns, building the `box_label skipped` record from the plain
 * columns (`shift_id`, `subject_id`) and never sending from it.
 */
export class UnreadableJobError extends Error {
  constructor(id: string) {
    super(`print job ${id} cannot be read`);
    this.name = "UnreadableJobError";
  }
}

function toJob(row: z.infer<typeof jobRow>): PrintJob {
  let printer: PrinterProfile | null = null;
  let fields: LabelFields;
  try {
    if (row.printer !== null) {
      printer = parsePrinterProfile(JSON.parse(row.printer));
      if (printer === null) throw new UnreadableJobError(row.id);
    }
    fields = fieldsSchema.parse(JSON.parse(row.fields));
  } catch {
    throw new UnreadableJobError(row.id);
  }
  return {
    id: row.id,
    shiftId: row.shift_id,
    purpose: row.purpose,
    subjectId: row.subject_id,
    sscc: row.sscc,
    state: row.state,
    verify: row.verify === 1,
    templateId: row.template_id,
    templateRev: row.template_rev,
    fields,
    printer,
    bytesBase64: row.bytes_base64,
    errorCode: row.error_code,
    attempts: row.attempts,
    operatorId: row.operator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The job `id` of the current pairing, or `null`. */
export async function readPrintJob(
  local: LocalExecutor,
  pairing: Pairing,
  id: string,
): Promise<PrintJob | null> {
  const [row] = await local.query(
    `SELECT ${COLUMNS} FROM floor_print_jobs WHERE host_id = ? AND device_id = ? AND id = ?`,
    [pairing.hostId, pairing.deviceId, id],
    jobRow,
  );
  return row === undefined ? null : toJob(row);
}

/**
 * The reading of `readOpenJob`; parameters: host id, device id, shift id. It
 * runs whenever a label may be due, so its plan is pinned in both lists of
 * plans: the shift's jobs through `floor_print_jobs_shift`, sorted for the
 * few that wait.
 */
export const OPEN_JOB_READ_SQL =
  `SELECT ${COLUMNS} FROM floor_print_jobs WHERE host_id = ? AND device_id = ? ` +
  `AND shift_id = ? AND ${OPEN_JOB_SQL} ORDER BY created_at, purpose, id LIMIT 1`;

/**
 * The oldest job of the shift that waits for the printer or the operator, or
 * `null`. A box's job before a pallet's of the same moment (`purpose`): the
 * box that fills a pallet writes both in its close (plan ПЛ-Ц), and the box's
 * label goes first.
 */
export async function readOpenJob(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<PrintJob | null> {
  const [row] = await local.query(
    OPEN_JOB_READ_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    jobRow,
  );
  return row === undefined ? null : toJob(row);
}

/**
 * Every label of the shift is done with: verified, skipped, or sent without a
 * check — no job of it can write a `box_label` record any more. Plan 2a8
 * closes a shift only then: a label decided after the shift's close would
 * reach the host after `shift_closed` and mark the station's own shift late
 * (`late_data_at`, plan 2a2). Counted, not read: a waiting job this build
 * cannot read still keeps the shift open.
 */
export async function shiftLabelsSettled(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<boolean> {
  const [row] = await local.query(
    `SELECT count(*) AS waiting FROM floor_print_jobs WHERE host_id = ? AND device_id = ? ` +
      `AND shift_id = ? AND ${OPEN_JOB_SQL}`,
    [pairing.hostId, pairing.deviceId, shiftId],
    z.object({ waiting: z.number().int() }),
  );
  return row?.waiting === 0;
}

/** How a label is rendered; the app's rasterizer by default, a test's own otherwise. */
export type RenderLabel = (
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
) => Promise<Uint8Array>;

/** What a new job is made from. */
export interface NewLabel {
  id: string;
  shiftId: string;
  purpose: LabelPurpose;
  subjectId: string;
  sscc: string;
  fields: LabelFields;
  /** The shift snapshot's template: its id, revision and layout. */
  template: { id: string; rev: number; spec: LabelTemplateSpec };
  operatorId: string;
  createdAt: string;
}

/**
 * The row of a new job, for the transaction that closes its box or pallet:
 * the printer of its purpose, the bytes rendered for it — `prepared` — or,
 * when no printer is assigned or the label does not render, `failed` with the
 * reason: the box closes all the same, and the operator decides at the
 * recovery screen. The label check is the workstation's setting now.
 */
export async function prepareLabelJob(
  label: NewLabel,
  settings: Pick<WorkstationSettings, "printers" | "assignments" | "verifyPrintedLabel">,
  pairing: Pairing,
  render: RenderLabel = renderLabel,
): Promise<LocalStatement> {
  const printer = resolvePrinter(settings, label.purpose);
  let bytes: string | null = null;
  let error: FailedCode | null = printer === null ? "printer_unconfigured" : null;
  if (printer !== null) {
    try {
      bytes = bytesToBase64(await render(label.template.spec, label.fields, printer));
    } catch {
      error = "render_failed";
    }
  }
  return {
    sql:
      `INSERT INTO floor_print_jobs (host_id, device_id, ${COLUMNS}) ` +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    values: [
      pairing.hostId,
      pairing.deviceId,
      label.id,
      label.shiftId,
      label.purpose,
      label.subjectId,
      label.sscc,
      error === null ? "prepared" : "failed",
      settings.verifyPrintedLabel ? 1 : 0,
      label.template.id,
      label.template.rev,
      JSON.stringify(label.fields),
      printer === null ? null : JSON.stringify(printer),
      bytes,
      error,
      label.operatorId,
      label.createdAt,
      label.createdAt,
    ],
    expectedChanges: 1,
  };
}

/**
 * The box close's step of plan 2a7 (`CloseStep`, plan 2a6): the box's print
 * job, rendered from the shift's snapshot with the SSCC, the count and the
 * time of the close, joins the close's own transaction — the box never
 * closes without its job, and no job exists for a box that did not close.
 * The workstation's settings are read at each close, so a printer set up a
 * minute ago prints the next box.
 */
export function boxLabelStep(deps: {
  local: LocalExecutor;
  pairing: Pairing;
  shift: WorkShift;
  operatorName: string | null;
  newId: () => string;
  render?: RenderLabel;
}): CloseStep {
  return async (box) => {
    const settings = await readWorkstationSettings(deps.local);
    const { boxTemplate } = deps.shift.snapshot;
    const statement = await prepareLabelJob(
      {
        id: deps.newId(),
        shiftId: box.shiftId,
        purpose: "box",
        subjectId: box.boxId,
        sscc: box.sscc,
        fields: boxLabelData(deps.shift, box, deps.operatorName),
        template: { id: boxTemplate.id, rev: boxTemplate.rev, spec: boxTemplate.spec },
        operatorId: box.operatorId,
        createdAt: box.closedAt,
      },
      settings,
      deps.pairing,
      deps.render,
    );
    return { statements: [statement] };
  };
}

/** The job changed between the read and the write: someone else moved it on. */
export class StaleJobError extends Error {
  constructor(id: string) {
    super(`print job ${id} changed meanwhile`);
    this.name = "StaleJobError";
  }
}

/** A job that cannot be sent as it is: no bytes or no printer, or a state no send starts from. */
export class UnsendableJobError extends Error {
  constructor(id: string, state: PrintJobState) {
    super(`print job ${id} cannot be sent from ${state}`);
    this.name = "UnsendableJobError";
  }
}

/** The bytes of a stored label. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Where a send leaves a job: `sent` only on the shell's `{ sent: true }`. */
export function settleOutcome(
  outcome: SendOutcome,
):
  | { state: "sent" }
  | { state: "failed"; code: FailedCode }
  | { state: "unknown"; code: UnknownCode } {
  if (outcome.kind === "timeout") return { state: "unknown", code: "timeout" };
  if (outcome.kind === "busy") return { state: "failed", code: "printer_busy" };
  const { result } = outcome;
  if (result.sent) return { state: "sent" };
  if (result.code === "outcome_unknown") return { state: "unknown", code: "outcome_unknown" };
  return { state: "failed", code: result.code };
}

/** What a send needs: the database, the pairing, the printers, a clock. */
export interface PrintContext {
  local: LocalExecutor;
  pairing: Pairing;
  runtime: PrintRuntime;
  now: () => Date;
}

/** The states a send may start from: a first send, a retry the operator chose, a reprint with a reason. */
const SEND_FROM: readonly PrintJobState[] = ["prepared", "failed", "unknown", "sent"];

/** What a send changes besides the state: another printer's profile and bytes, the reprint's records. */
export interface SendOptions {
  /**
   * The job's new printer and the bytes rendered for it, written with `sending`.
   * They replace the old ones: after an `unknown` on one printer a label may
   * exist there, and the row no longer says so — the caller's `extra` (the
   * reprint's exception) must name the former printer, and the bytes must be
   * rendered from the snapshot's template revision (`template_id`/`template_rev`),
   * which this layer neither re-renders nor checks against the printer's language.
   */
  rebind?: { printer: PrinterProfile; bytesBase64: string };
  /** Written in the same transaction as `sending`: a reprint's exception and its record. */
  extra?: readonly LocalStatement[];
}

/**
 * Sends a job's bytes (stage 2a spec §5.7.5). `sending` and one more attempt
 * are written BEFORE the bytes go — together with the new printer and bytes
 * of `rebind` and the statements of `extra` (the reprint's exception when the
 * operator sends a label that may already exist) — so a crash in between
 * leaves `sending`, which a restart reads as `unknown`.
 * Then one send through the runtime and one write of where it ended: `sent`
 * only on the shell's `{ sent: true }`, `failed` when nothing left this
 * computer, `unknown` otherwise. Each write compares the job with what was
 * read (`StaleJobError` otherwise), so a late answer never overwrites a job
 * the recovery or the operator moved on. Nothing here ever sends a job
 * again by itself: every send after the first is the operator's.
 *
 * This layer does not decide whether a send is allowed to repeat a label that
 * may already exist: `unknown` and `sent` are accepted here with no reason.
 * The caller (`printAgain`, plan 2a7 task 5, and the reprints of plan 2a8) must
 * refuse them without a reprint reason, and reprint a settled box through a
 * new job rather than through this path.
 *
 * `bytes_base64` of a job is not bounded in size here (a raster-heavy label
 * near the canvas cap is several MB of base64 across the IPC on every
 * write, read and send); the retention of plan 2a8 removes old rows.
 */
export async function sendLabelJob(
  context: PrintContext,
  job: PrintJob,
  options: SendOptions = {},
): Promise<PrintJob> {
  const { local, pairing, runtime } = context;
  const printer = options.rebind?.printer ?? job.printer;
  const bytesBase64 = options.rebind?.bytesBase64 ?? job.bytesBase64;
  if (printer === null || bytesBase64 === null || !SEND_FROM.includes(job.state)) {
    throw new UnsendableJobError(job.id, job.state);
  }
  const attempt = job.attempts + 1;
  try {
    await local.transaction([
      {
        sql:
          "UPDATE floor_print_jobs SET state = 'sending', attempts = ?, error_code = NULL, " +
          "printer = ?, bytes_base64 = ?, updated_at = ? " +
          "WHERE host_id = ? AND device_id = ? AND id = ? AND state = ? AND attempts = ?",
        values: [
          attempt,
          JSON.stringify(printer),
          bytesBase64,
          context.now().toISOString(),
          pairing.hostId,
          pairing.deviceId,
          job.id,
          job.state,
          job.attempts,
        ],
        expectedChanges: 1,
      },
      ...(options.extra ?? []),
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleJobError(job.id);
    }
    throw error;
  }
  const outcome = await runtime.send(job.id, printer.target, base64ToBytes(bytesBase64));
  const settled = settleOutcome(outcome);
  try {
    await local.transaction([
      {
        sql:
          "UPDATE floor_print_jobs SET state = ?, error_code = ?, updated_at = ? " +
          "WHERE host_id = ? AND device_id = ? AND id = ? AND state = 'sending' AND attempts = ?",
        values: [
          settled.state,
          settled.state === "sent" ? null : settled.code,
          context.now().toISOString(),
          pairing.hostId,
          pairing.deviceId,
          job.id,
          attempt,
        ],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleJobError(job.id);
    }
    throw error;
  }
  const after = await readPrintJob(local, pairing, job.id);
  if (after === null) throw new StaleJobError(job.id);
  return after;
}

/**
 * Turns every `sending` job of the pairing whose bytes no send of this app
 * holds into `unknown` (`interrupted`): the app stopped, or the write of a
 * send's end was lost, after the bytes may have gone. Run when the work
 * screen opens and before it reads a job to decide on; the runtime's jobs in
 * flight are left as they are. Answers how many jobs it moved.
 *
 * A hard rule for every caller: never run it concurrently with a
 * `sendLabelJob` of this app — only from the work queue, one thing at a time.
 * `sendLabelJob` commits `sending` first and registers the job with the
 * runtime only after that commit; a recovery whose in-flight snapshot falls
 * between the two would turn a job whose bytes are about to go into
 * `unknown`, and the send's own final write would then be refused
 * (`StaleJobError`). That is a spurious `unknown` the operator decides, never
 * a second send — but it is avoidable by keeping the two serialised.
 */
export async function recoverInterruptedJobs(context: PrintContext): Promise<number> {
  const { local, pairing, runtime } = context;
  const [changed] = await local.transaction([
    {
      sql:
        "UPDATE floor_print_jobs SET state = 'unknown', error_code = 'interrupted', updated_at = ? " +
        "WHERE host_id = ? AND device_id = ? AND state = 'sending' " +
        "AND id NOT IN (SELECT value FROM json_each(?))",
      values: [
        context.now().toISOString(),
        pairing.hostId,
        pairing.deviceId,
        JSON.stringify(runtime.inFlight()),
      ],
    },
  ]);
  return changed ?? 0;
}
