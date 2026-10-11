import { parseScannedSscc, type LabelTemplateSpec } from "@markiro/domain";

import { bytesToBase64 } from "../../hardware/hardware.js";
import { LocalDbError, type LocalStatement } from "../../local/executor.js";
import type { ReprintReason } from "../exception-reasons.js";
import { boxLabelRecord, exceptionStatements, outboxStatement } from "../facts.js";
import {
  resolvePrinter,
  type PrinterProfile,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
import { renderLabel } from "./label-render.js";
import {
  readPrintJob,
  sendLabelJob,
  StaleJobError,
  type PrintContext,
  type PrintJob,
  type PrintJobState,
  type RenderLabel,
} from "./print-jobs.js";

/** What the operator's decisions on a label need besides the send's context. */
export interface ResolveContext extends PrintContext {
  /** The operator signed in now: the records name them. */
  operatorId: string;
  newId: () => string;
}

/** The job is in no state this decision is for (the screen offered it by mistake, or it moved on). */
export class UnresolvableJobError extends Error {
  constructor(id: string, state: PrintJobState) {
    super(`print job ${id} cannot be resolved so from ${state}`);
    this.name = "UnresolvableJobError";
  }
}

/** No printer to print on: the job's own is gone from the settings and none is assigned. */
export class NoPrinterError extends Error {
  constructor() {
    super("no printer for the label");
    this.name = "NoPrinterError";
  }
}

/** The label would not render for the chosen printer; nothing was changed or sent. */
export class LabelRenderError extends Error {
  constructor() {
    super("the label did not render");
    this.name = "LabelRenderError";
  }
}

/**
 * The record of a label's check for the host: `box_label` for a box. A
 * pallet's (`pallet_label`) is the pallets' plan's to add (ПЛ-Ц).
 */
function labelRecord(
  context: ResolveContext,
  job: PrintJob,
  outcome: "verified" | "skipped",
  at: string,
) {
  const head = { id: context.newId(), shiftId: job.shiftId, operatorId: context.operatorId };
  switch (job.purpose) {
    case "box":
      return boxLabelRecord(head, { boxId: job.subjectId, outcome, at });
    case "pallet":
      throw new UnresolvableJobError(job.id, job.state);
  }
}

/**
 * The records of a reprint (decision 36): the station's `floor_exceptions`
 * row and the `box_exception` record of kind `reprint` with its reason, no
 * words (the work screen offers the codes only) — written by the one writer
 * of exceptions (`exceptionStatements`), as the reprint of a settled box is
 * (plan 2a8). A pallet's reprint is the pallets' plan's.
 */
function reprintStatements(
  context: ResolveContext,
  job: PrintJob,
  reason: ReprintReason,
  at: string,
): LocalStatement[] {
  if (job.purpose !== "box") throw new UnresolvableJobError(job.id, job.state);
  return exceptionStatements(context, job.shiftId, {
    exception: "reprint",
    boxId: job.subjectId,
    codeHash: null,
    targetScannedAt: null,
    reasonCode: reason,
    reasonText: null,
    occurredAt: at,
  });
}

/** Writes `statements` (the first one compares the job), mapping a lost comparison to `StaleJobError`. */
async function commit(
  context: ResolveContext,
  job: PrintJob,
  statements: readonly LocalStatement[],
): Promise<PrintJob> {
  try {
    await context.local.transaction(statements);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleJobError(job.id);
    }
    throw error;
  }
  const after = await readPrintJob(context.local, context.pairing, job.id);
  if (after === null) throw new StaleJobError(job.id);
  return after;
}

/** The comparing update of a job's state. */
function move(
  context: ResolveContext,
  job: PrintJob,
  state: PrintJobState,
  at: string,
): LocalStatement {
  return {
    sql:
      "UPDATE floor_print_jobs SET state = ?, error_code = NULL, updated_at = ? " +
      "WHERE host_id = ? AND device_id = ? AND id = ? AND state = ? AND attempts = ?",
    values: [
      state,
      at,
      context.pairing.hostId,
      context.pairing.deviceId,
      job.id,
      job.state,
      job.attempts,
    ],
    expectedChanges: 1,
  };
}

/** A check is waiting on this job: it was sent and asks for the scan of its label. */
export function awaitsCheck(job: Pick<PrintJob, "state" | "verify">): boolean {
  return job.state === "sent" && job.verify;
}

/** The answer to a scan while a label's check waits. */
export type CheckResult =
  { kind: "verified"; job: PrintJob } | { kind: "not_sscc" } | { kind: "mismatch"; sscc: string };

/**
 * The scan of a printed label (decision 21): an SSCC read by the domain
 * (`parseScannedSscc`, with or without `(00)` and the AIM prefix) equal to the
 * job's — `verified` and the `box_label` record in one transaction; another
 * SSCC — `mismatch`; anything else — `not_sscc`. Nothing is written for
 * either refusal.
 */
export async function checkLabel(
  context: ResolveContext,
  job: PrintJob,
  raw: string,
): Promise<CheckResult> {
  if (!awaitsCheck(job)) throw new UnresolvableJobError(job.id, job.state);
  const sscc = parseScannedSscc(raw);
  if (sscc === null) return { kind: "not_sscc" };
  if (sscc !== job.sscc) return { kind: "mismatch", sscc };
  const at = context.now().toISOString();
  const verified = await commit(context, job, [
    move(context, job, "verified", at),
    outboxStatement(labelRecord(context, job, "verified", at), context.pairing, at),
  ]);
  return { kind: "verified", job: verified };
}

/**
 * «Продолжить без этикетки» / «Пропустить проверку»: the operator goes on
 * without a checked label — from a check that waits, a failed job or an
 * unknown one (the cloud's «Продолжить без этикетки»). `skipped` and the
 * `box_label` record `skipped`, in one transaction; the box can get a label
 * later by a reprint (plan 2a8).
 */
export async function skipLabel(context: ResolveContext, job: PrintJob): Promise<PrintJob> {
  if (!(awaitsCheck(job) || job.state === "failed" || job.state === "unknown")) {
    throw new UnresolvableJobError(job.id, job.state);
  }
  const at = context.now().toISOString();
  return commit(context, job, [
    move(context, job, "skipped", at),
    outboxStatement(labelRecord(context, job, "skipped", at), context.pairing, at),
  ]);
}

/**
 * «Этикетка напечаталась»: the operator sees the label of an `unknown` job
 * on the box. `sent` — done with, or the check next when the job asks for it.
 * Only from `unknown`: a failed job left nothing on any printer.
 */
export async function confirmPrinted(context: ResolveContext, job: PrintJob): Promise<PrintJob> {
  if (job.state !== "unknown") throw new UnresolvableJobError(job.id, job.state);
  const at = context.now().toISOString();
  return commit(context, job, [move(context, job, "sent", at)]);
}

/** Where to print again: the job's own printer as the settings have it now, or another one. */
export interface PrintAgain {
  /** The operator's reason: required when a label may already exist (`unknown`, a check waiting). */
  reason: ReprintReason | null;
  /** «Другой принтер»: this profile; otherwise the job's own, or the purpose's printer. */
  printer: PrinterProfile | null;
}

/** The printer a print again goes to. */
export function printerForAgain(
  job: Pick<PrintJob, "printer" | "purpose">,
  settings: Pick<WorkstationSettings, "printers" | "assignments">,
  chosen: PrinterProfile | null,
): PrinterProfile | null {
  if (chosen !== null) return chosen;
  const own = job.printer === null ? null : settings.printers.find((p) => p.id === job.printer?.id);
  return own ?? resolvePrinter(settings, job.purpose);
}

/**
 * «Напечатать снова» and «Другой принтер» (stage 2a spec §5.7.5): only the
 * operator's decision ever sends a label again. A failed job is sent again
 * as it is; a job whose label may exist — `unknown`, or `sent` with a check
 * that failed to read it — only with a reason, written as a reprint
 * exception in the transaction that marks the job `sending`. The bytes are
 * the job's when the printer's language and resolution are the job's, and
 * rendered again from the shift's snapshot otherwise (`template` must be the
 * job's own revision). No printer — `NoPrinterError`; no render —
 * `LabelRenderError`; neither changes or sends anything.
 *
 * Known limit: a rebind overwrites the job's printer and bytes, and the
 * reprint exception has no field that could name the printer the first label
 * may have come out on (`floor_exceptions` allows words only with `other`,
 * and the host's `box_exception` has no printer): the audit trail says that a
 * second label may exist for the SSCC, not where. Naming the former printer
 * needs a column or a record of its own (a later migration).
 */
export async function printAgain(
  context: ResolveContext,
  job: PrintJob,
  request: PrintAgain,
  settings: Pick<WorkstationSettings, "printers" | "assignments">,
  template: { id: string; rev: number; spec: LabelTemplateSpec },
  render: RenderLabel = renderLabel,
): Promise<PrintJob> {
  const mayExist = job.state === "unknown" || awaitsCheck(job);
  if (!(job.state === "failed" || mayExist)) throw new UnresolvableJobError(job.id, job.state);
  if (mayExist && request.reason === null) throw new UnresolvableJobError(job.id, job.state);
  if (template.id !== job.templateId || template.rev !== job.templateRev) {
    throw new UnresolvableJobError(job.id, job.state);
  }
  const printer = printerForAgain(job, settings, request.printer);
  if (printer === null) throw new NoPrinterError();
  let bytesBase64 = job.bytesBase64;
  const sameRender =
    job.printer !== null &&
    job.printer.language === printer.language &&
    job.printer.dpi === printer.dpi;
  if (bytesBase64 === null || !sameRender) {
    try {
      bytesBase64 = bytesToBase64(await render(template.spec, job.fields, printer));
    } catch {
      throw new LabelRenderError();
    }
  }
  const at = context.now().toISOString();
  return sendLabelJob(context, job, {
    rebind: { printer, bytesBase64 },
    extra:
      mayExist && request.reason !== null
        ? reprintStatements(context, job, request.reason, at)
        : [],
  });
}
