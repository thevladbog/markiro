import {
  compareDuplicateKm,
  DomainError,
  duplicatePayloadDigest,
  kmHash,
  parseDuplicateKm,
  productLabelBytesDigest,
  productLabelStatus,
  type ProductLabelJobStatus,
  type ReprintReason,
} from "@markiro/domain";

import { bytesToBase64 } from "../../hardware/hardware.js";
import type { ScannedCode, UnitLabelFact } from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { outboxStatement, unitLabelRecord } from "../facts.js";
import type { LabelFields } from "../print/label-render.js";
import { base64ToBytes } from "../print/print-jobs.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import type { ShiftRenderDeps } from "../print/shift-render.js";
import {
  printerMode,
  readWorkstationSettings,
  resolvePrinter,
  type PrinterProfile,
} from "../setup/workstation-settings.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import { unitLabelFields, unitLabelRender, type RenderUnitLabel } from "./unit-label-render.js";
import {
  INSERT_JOB_SQL,
  moveJobStatement,
  readSendingUnitLabels,
  readUnitLabelJob,
  readUnresolvedUnitLabelRef,
  unitLabelRef,
  type UnitLabelJob,
  type UnitLabelMove,
  type UnitLabelRef,
} from "./unit-label-store.js";

/*
 * The station's unit labels (plan РЕЖ part B, task B5; Р12–Р14; migration
 * `0015`): the Data Matrix duplicate of each unit a validation shift accepts,
 * by the domain's machine (`packages/domain/src/product-labels`) without the
 * cloud's offline grants. Every step of a job is ONE transaction of its guarded
 * `MOVE_JOB_SQL` and its `unit_label` record, so the row and the host's trace
 * never differ, and a job moved meanwhile changes nothing (`StaleUnitLabelError`).
 * The full code lives only in the job's fields and bytes: no `unit_label`
 * record carries it (they carry its hash and the digests), and neither does a
 * scan's outcome nor a refusal (`UnitLabelRef`). The unit's own `scan` record
 * carries `code.canonical` by design, as every validation scan's does.
 */

/**
 * Why a unit is not accepted, or a label not printed again, before anything
 * is written: no duplicate printer is assigned (`printer_unconfigured`, as the
 * cloud answers `error: "printer"`), the label does not render
 * (`render_failed`), the code has no crypto tail to duplicate
 * (`incomplete_km`, the domain's `parseDuplicateKm`); the station's one
 * unresolved job is in the way, by its gate (`canAcceptNext`) — this shift's
 * label waits for its check (`verify`) or for the operator's send or decision
 * (`wait`), or it is another shift's (`another_shift`); or a reprint asked
 * from one shift names another shift's completed label (`shift_mismatch`, the
 * cloud's `PRODUCT_LABEL_SHIFT_MISMATCH`).
 */
export type UnitLabelRefusal =
  | "printer_unconfigured"
  | "render_failed"
  | "incomplete_km"
  | "verify"
  | "wait"
  | "another_shift"
  | "shift_mismatch";

/**
 * A unit or a reprint refused before any write; `job` — the job in the way,
 * by its light reference only (a copy: never its fields, its code nor its bytes).
 */
export class UnitLabelRefusedError extends Error {
  readonly code: UnitLabelRefusal;
  readonly job: UnitLabelRef | null;
  constructor(code: UnitLabelRefusal, job: UnitLabelRef | null = null) {
    super(`unit label: ${code}`);
    this.name = "UnitLabelRefusedError";
    this.code = code;
    this.job = job === null ? null : unitLabelRef(job);
  }
}

/** A job that cannot take this action in its state (the domain refuses its event too). */
export class UnitLabelStateError extends Error {
  constructor(id: string, state: string) {
    super(`unit label job ${id} cannot do this from ${state}`);
    this.name = "UnitLabelStateError";
  }
}

/** A job that moved on since it was read (or whose send runs): nothing was written. */
export class StaleUnitLabelError extends Error {
  constructor(id: string) {
    super(`unit label job ${id} changed meanwhile`);
    this.name = "StaleUnitLabelError";
  }
}

/**
 * A step of a job that did not move, refused because this station closed the
 * job's shift (`outboxStatement` takes no record after its `shift_closed`):
 * nothing was written, and reading the job again would never settle it.
 */
export class UnitLabelShiftClosedError extends Error {
  constructor(id: string) {
    super(`unit label job ${id}: its shift is closed on this station`);
    this.name = "UnitLabelShiftClosedError";
  }
}

/** The domain's status of a job (`productLabelStatus`). */
export function unitLabelStatus(
  job: Pick<UnitLabelJob, "attemptState" | "verificationPolicy" | "verification">,
): ProductLabelJobStatus {
  return productLabelStatus(
    job.attemptState,
    job.verificationPolicy,
    job.verification === "verified",
    job.verification === "skipped",
  );
}

/**
 * What the next scan of a printing shift is (the cloud's `canAccept`): a new
 * unit (`accept`) once the station's job is completed in the domain's words —
 * none, its check done or skipped, or sent under no check; the check of the
 * printed label (`verify`) while a required check waits for it or a send's
 * outcome is unknown (a scan of the label that came out settles it); nothing
 * (`wait`) while the job is prepared, sending or failed before its send — the
 * operator sends or prints it again; and nothing in this shift while the
 * station's unresolved job is another shift's (`another_shift`).
 */
export type UnitLabelGate<J extends UnitLabelRef = UnitLabelRef> =
  | { kind: "accept" }
  | { kind: "verify"; job: J }
  | { kind: "wait"; job: J; status: ProductLabelJobStatus }
  | { kind: "another_shift"; job: J };

export function canAcceptNext<J extends UnitLabelRef>(
  job: J | null,
  shiftId: string,
): UnitLabelGate<J> {
  if (job === null) return { kind: "accept" };
  const status = unitLabelStatus(job);
  if (status === "completed") return { kind: "accept" };
  if (job.shiftId !== shiftId) return { kind: "another_shift", job };
  if (status === "awaiting_verification" || job.attemptState === "delivery_unknown") {
    return { kind: "verify", job };
  }
  return { kind: "wait", job, status };
}

/** What a unit's acceptance needs besides the scan: the database, the shift, the operator, a render. */
export interface UnitLabelContext {
  local: LocalExecutor;
  pairing: Pairing;
  shift: WorkShift;
  operatorId: string;
  /** The name the label prints as its operator. */
  operatorName: string;
  now: () => Date;
  newId: () => string;
  /** The whole render, replaced (tests); left out, `unitLabelRender` with `labelDeps`. */
  render?: RenderUnitLabel;
  /** What the app's render takes instead of its own rasterizer and logo loaders (tests). */
  labelDeps?: ShiftRenderDeps;
}

/** What a send, a check, a skip, a reprint and the recovery need. */
export interface UnitLabelPrintContext {
  local: LocalExecutor;
  pairing: Pairing;
  runtime: PrintRuntime;
  now: () => Date;
  newId: () => string;
}

/** The duplicate printer the settings assign now, or `null` (an A4 printer prints no unit label). */
async function duplicatePrinter(local: LocalExecutor): Promise<PrinterProfile | null> {
  return resolvePrinter(await readWorkstationSettings(local), "duplicate");
}

/**
 * Refuses a scan of a printing shift before anything is read or written (the
 * cloud's station takes no scan while it cannot accept): the station's
 * unresolved job is in the way (`verify`, `wait`, `another_shift` — its gate,
 * read light, without its fields or bytes) or no duplicate printer is assigned
 * (`printer_unconfigured`). Answers that printer.
 */
export async function checkUnitAcceptance(
  context: Pick<UnitLabelContext, "local" | "pairing" | "shift">,
): Promise<PrinterProfile> {
  const gate = canAcceptNext(
    await readUnresolvedUnitLabelRef(context.local, context.pairing),
    context.shift.copy.id,
  );
  if (gate.kind !== "accept") throw new UnitLabelRefusedError(gate.kind, gate.job);
  const printer = await duplicatePrinter(context.local);
  if (printer === null) throw new UnitLabelRefusedError("printer_unconfigured");
  return printer;
}

/** The fact of one event of `job`. */
function fact(
  job: Pick<UnitLabelJob, "id" | "codeHash" | "payloadDigest" | "bytesDigest">,
  event: Pick<UnitLabelFact, "attemptNo" | "event" | "reason" | "errorCode">,
  at: string,
): UnitLabelFact {
  return {
    jobId: job.id,
    codeHash: job.codeHash,
    payloadDigest: job.payloadDigest,
    bytesDigest: job.bytesDigest,
    ...event,
    at,
  };
}

/**
 * A unit accepted by the scan path (`processScan`): its scan's id (the
 * journal row's and the `scan` record's), its code and moment, and the
 * statements that take it — its place in `floor_codes`, its journal row and
 * its `scan` record, in this order.
 */
export interface AcceptedUnit {
  scanId: string;
  code: ScannedCode;
  scannedAt: string;
  statements: readonly LocalStatement[];
}

/**
 * Accepts a unit of a shift that prints its duplicate, with its label (Р12):
 * refused before anything is written while the station's job waits, no
 * duplicate printer is assigned, the code has no crypto tail or the label does
 * not render for the printer — then ONE transaction: the unit's statements
 * (`floor_codes`, `floor_scans`, its `scan` record), the job `prepared` with
 * the bytes rendered for the printer and its print identity, and the
 * `unit_label` record `prepared` after the `scan` record, so the host knows
 * the unit before its label (its `subject_unknown`; the outbox goes in order).
 * The bytes are the snapshot's duplicate layout with the unit's fields; a
 * reprint sends them again, the date included. Answers the job by its light
 * reference: the caller reads it whole to send it.
 */
export async function acceptWithLabel(
  context: UnitLabelContext,
  unit: AcceptedUnit,
): Promise<UnitLabelRef> {
  const { local, pairing, shift } = context;
  const policy = shift.snapshot.validationPrint;
  if (policy === null) throw new Error("acceptWithLabel: the shift prints no duplicate");
  const printer = await checkUnitAcceptance(context);
  let fields: LabelFields;
  let payloadDigest: string;
  try {
    const km = parseDuplicateKm(unit.code.canonical);
    // The code printed is the code accepted: never another identity. Not a refusal of the
    // unit's code — the caller handed a hash that is not its code's (no scan does).
    if (kmHash(km) !== unit.code.codeHash) {
      throw new Error("acceptWithLabel: the label would carry another code than the one accepted");
    }
    fields = unitLabelFields(shift, km.raw, unit.scannedAt, context.operatorName);
    payloadDigest = duplicatePayloadDigest(km.raw);
  } catch (error) {
    if (error instanceof DomainError) throw new UnitLabelRefusedError("incomplete_km");
    throw error;
  }
  const render = context.render ?? unitLabelRender(shift, context.labelDeps);
  let bytes: Uint8Array;
  try {
    bytes = await render(policy.template.spec, fields, printer);
  } catch {
    throw new UnitLabelRefusedError("render_failed");
  }
  const mode = printerMode(printer);
  const job = {
    id: context.newId(),
    codeHash: unit.code.codeHash,
    payloadDigest,
    bytesDigest: productLabelBytesDigest(bytes),
  };
  const verificationPolicy = policy.verification;
  const at = unit.scannedAt;
  const insert: LocalStatement = {
    sql: INSERT_JOB_SQL,
    values: [
      job.id,
      pairing.hostId,
      pairing.deviceId,
      shift.copy.id,
      job.codeHash,
      unit.scanId,
      verificationPolicy,
      verificationPolicy === "required" ? "pending" : "not_required",
      mode,
      mode === "windows_driver" ? null : printer.language,
      printer.dpi,
      bytesToBase64(bytes),
      job.bytesDigest,
      job.payloadDigest,
      policy.template.id,
      policy.template.rev,
      JSON.stringify(fields),
      context.operatorId,
      at,
      at,
    ],
    expectedChanges: 1,
  };
  const record = unitLabelRecord(
    { id: context.newId(), shiftId: shift.copy.id, operatorId: context.operatorId },
    fact(job, { attemptNo: 1, event: "prepared", reason: null, errorCode: null }, at),
  );
  await local.transaction([...unit.statements, insert, outboxStatement(record, pairing, at)]);
  const stored = await readUnitLabelJob(local, pairing, job.id);
  if (stored === null) throw new StaleUnitLabelError(job.id);
  return unitLabelRef(stored);
}

/**
 * One step of `job` and its record in one transaction; the job as it is after
 * it. The record's error code is the event's own: the attempt's for
 * `failed_before_send` and `delivery_unknown`, the verdict for
 * `verification_rejected`, none otherwise (a check of an unknown outcome keeps
 * the attempt's code on the row, not on its event). A step refused whole
 * (`changes_mismatch`) is told apart by the job read again: one that moved is
 * `StaleUnitLabelError`; one that did not had its record refused — this
 * station closed the job's shift (`UnitLabelShiftClosedError`).
 */
async function step(
  context: Pick<UnitLabelPrintContext, "local" | "pairing" | "now" | "newId">,
  job: UnitLabelJob,
  move: UnitLabelMove,
  event: { event: UnitLabelFact["event"]; errorCode?: string },
  operatorId: string | null,
): Promise<UnitLabelJob> {
  const { local, pairing } = context;
  const at = context.now().toISOString();
  const errorCode =
    event.event === "failed_before_send" || event.event === "delivery_unknown"
      ? move.errorCode
      : (event.errorCode ?? null);
  const record = unitLabelRecord(
    { id: context.newId(), shiftId: job.shiftId, operatorId },
    fact(
      job,
      {
        attemptNo: move.attemptNo,
        event: event.event,
        reason: event.event === "prepared" ? move.reason : null,
        errorCode,
      },
      at,
    ),
  );
  try {
    await local.transaction([
      moveJobStatement(pairing, job, move, at),
      outboxStatement(record, pairing, at),
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      const now = await readUnitLabelJob(local, pairing, job.id);
      const unmoved =
        now !== null &&
        now.attemptNo === job.attemptNo &&
        now.attemptState === job.attemptState &&
        now.verification === job.verification;
      throw unmoved ? new UnitLabelShiftClosedError(job.id) : new StaleUnitLabelError(job.id);
    }
    throw error;
  }
  const after = await readUnitLabelJob(local, pairing, job.id);
  if (after === null) throw new StaleUnitLabelError(job.id);
  return after;
}

/** The job's current attempt with another state (and error code). */
function attempt(
  job: UnitLabelJob,
  attemptState: UnitLabelJob["attemptState"],
  errorCode: string | null = null,
): UnitLabelMove {
  return {
    attemptNo: job.attemptNo,
    attemptState,
    verification: job.verification,
    reason: job.reason,
    errorCode,
  };
}

/**
 * The sends of this app run in progress, per print runtime (one per app run,
 * as the cloud's `activeSends`): a job is here from before its `sending` is
 * written until its send's last write, so the recovery — which may run at any
 * moment, the panel's every load — never takes a send of this run for one a
 * stop cut, even before the runtime holds its bytes.
 */
const activeSends = new WeakMap<PrintRuntime, Set<string>>();

function sendKey(pairing: Pairing, jobId: string): string {
  return JSON.stringify([pairing.hostId, pairing.deviceId, jobId]);
}

function sendsOf(runtime: PrintRuntime): Set<string> {
  let sends = activeSends.get(runtime);
  if (sends === undefined) {
    sends = new Set();
    activeSends.set(runtime, sends);
  }
  return sends;
}

/** A send of `jobId` runs in this app run (from before its `sending` to its last write). */
export function isUnitLabelSendActive(context: UnitLabelPrintContext, jobId: string): boolean {
  return sendsOf(context.runtime).has(sendKey(context.pairing, jobId));
}

/**
 * Sends a prepared attempt (Р12): the duplicate printer assigned now must
 * print the job's identity — none is `failed_before_send`
 * `printer_unconfigured`, another way of printing, language or resolution
 * `printer_changed` (the bytes are for one printer, and a reprint sends the
 * same), and so is a page for the Windows driver where this computer prints
 * through no driver (`supportsWindowsDriver`: the send could only be refused,
 * never leave) — and nothing leaves this computer. Otherwise `sending` is
 * written before the bytes go, so a crash in between leaves `sending` for the
 * recovery, then one send through the runtime and `sent` on the shell's
 * `{ sent: true }`, else `delivery_unknown` `transport_failed`: the domain has
 * no failure after `sending` (as the cloud, which records any failed send so),
 * and a label may exist. Nothing here sends again by itself: only a prepared
 * attempt is sent, and one at a time (a second send of a job whose send runs
 * is `StaleUnitLabelError`, nothing written).
 */
export async function sendUnitLabel(
  context: UnitLabelPrintContext,
  job: UnitLabelJob,
  operatorId: string | null,
): Promise<UnitLabelJob> {
  if (job.attemptState !== "prepared") throw new UnitLabelStateError(job.id, job.attemptState);
  if (isUnitLabelSendActive(context, job.id)) throw new StaleUnitLabelError(job.id);
  const printer = await duplicatePrinter(context.local);
  if (printer === null) {
    return step(
      context,
      job,
      attempt(job, "failed_before_send", "printer_unconfigured"),
      { event: "failed_before_send" },
      operatorId,
    );
  }
  const mode = printerMode(printer);
  if (
    mode !== job.printMode ||
    (mode === "raw" && printer.language !== job.language) ||
    printer.dpi !== job.dpi ||
    (mode === "windows_driver" && !(await context.runtime.supportsWindowsDriver()))
  ) {
    return step(
      context,
      job,
      attempt(job, "failed_before_send", "printer_changed"),
      { event: "failed_before_send" },
      operatorId,
    );
  }
  const sends = sendsOf(context.runtime);
  const key = sendKey(context.pairing, job.id);
  sends.add(key);
  try {
    const sending = await step(
      context,
      job,
      attempt(job, "sending"),
      { event: "sending" },
      operatorId,
    );
    const outcome = await context.runtime.send(
      job.id,
      printer.target,
      base64ToBytes(sending.bytesBase64),
      mode,
    );
    if (outcome.kind === "answered" && outcome.result.sent) {
      return await step(context, sending, attempt(sending, "sent"), { event: "sent" }, operatorId);
    }
    return await step(
      context,
      sending,
      attempt(sending, "delivery_unknown", "transport_failed"),
      { event: "delivery_unknown" },
      operatorId,
    );
  } finally {
    sends.delete(key);
  }
}

/** The check of a printed label is open: a required check after `sent`, or an unknown outcome. */
function checkOpen(job: UnitLabelJob): boolean {
  if (job.verification === "verified" || job.verification === "skipped") return false;
  return (
    job.attemptState === "delivery_unknown" ||
    (job.attemptState === "sent" && job.verificationPolicy === "required")
  );
}

/**
 * Checks a printed label by a scan of it (Р12, the domain's
 * `compareDuplicateKm`): the full content of the new label, crypto tail
 * included, equal to the job's code is `verified`; another code is
 * `verification_rejected` `mismatch`, an unreadable one (a code without its
 * tail too) `invalid`, the job unchanged. A rejection writes the job's step as
 * it was read (a guarded no-op), so a check of an attempt that moved on is
 * journalled neither way (`StaleUnitLabelError`).
 */
export async function verifyUnitLabel(
  context: UnitLabelPrintContext,
  job: UnitLabelJob,
  raw: string,
  operatorId: string | null,
): Promise<{ kind: "verified" | "mismatch" | "invalid"; job: UnitLabelJob }> {
  if (!checkOpen(job))
    throw new UnitLabelStateError(job.id, `${job.attemptState}/${job.verification}`);
  const expected = job.fields["km.code"];
  if (expected === undefined) throw new UnitLabelStateError(job.id, "no code");
  const verdict = compareDuplicateKm(expected, raw);
  if (verdict === "match") {
    const verified = await step(
      context,
      job,
      { ...attempt(job, job.attemptState, job.errorCode), verification: "verified" },
      { event: "verified" },
      operatorId,
    );
    return { kind: "verified", job: verified };
  }
  // The job's step as it was read: nothing changes but the time, and only if nothing moved it.
  const rejected = await step(
    context,
    job,
    attempt(job, job.attemptState, job.errorCode),
    { event: "verification_rejected", errorCode: verdict },
    operatorId,
  );
  return { kind: verdict, job: rejected };
}

/**
 * Skips the required check of a label sent to the printer (Р12): only after
 * `sent`, the check still pending; saved as `verification_skipped` with the
 * operator and the time, never as a verification. An unknown or failed send
 * cannot be skipped.
 */
export async function skipVerification(
  context: UnitLabelPrintContext,
  job: UnitLabelJob,
  operatorId: string,
): Promise<UnitLabelJob> {
  if (
    job.attemptState !== "sent" ||
    job.verificationPolicy !== "required" ||
    job.verification !== "pending"
  ) {
    throw new UnitLabelStateError(job.id, `${job.attemptState}/${job.verification}`);
  }
  return step(
    context,
    job,
    { ...attempt(job, "sent"), verification: "skipped" },
    { event: "verification_skipped" },
    operatorId,
  );
}

/**
 * Prints a job's label again (Р12) from the shift `shiftId` the operator
 * works: a new attempt with the operator's reason, `prepared` with the job's
 * own bytes — the same text, date and print identity — and its check pending
 * again under a required check; no unit more. Not while its attempt is
 * prepared or sending; not a completed label of another shift, which this
 * shift has no business reopening (`shift_mismatch`, the cloud's
 * `PRODUCT_LABEL_SHIFT_MISMATCH`) — another shift's unresolved label may be,
 * so the station is never stuck behind it; and not while another job of the
 * station is unresolved (its gate from `shiftId`: one at a time). The caller
 * sends it.
 */
export async function reprintUnitLabel(
  context: UnitLabelPrintContext,
  job: UnitLabelJob,
  reason: ReprintReason,
  operatorId: string,
  shiftId: string,
): Promise<UnitLabelJob> {
  if (job.attemptState === "prepared" || job.attemptState === "sending") {
    throw new UnitLabelStateError(job.id, job.attemptState);
  }
  if (job.shiftId !== shiftId && unitLabelStatus(job) === "completed") {
    throw new UnitLabelRefusedError("shift_mismatch", job);
  }
  const unresolved = await readUnresolvedUnitLabelRef(context.local, context.pairing);
  if (unresolved !== null && unresolved.id !== job.id) {
    const gate = canAcceptNext(unresolved, shiftId);
    // An unresolved job is never completed: its gate is always one of the three refusals.
    throw new UnitLabelRefusedError(gate.kind === "accept" ? "wait" : gate.kind, unresolved);
  }
  return step(
    context,
    job,
    {
      attemptNo: job.attemptNo + 1,
      attemptState: "prepared",
      verification: job.verificationPolicy === "required" ? "pending" : "not_required",
      reason,
      errorCode: null,
    },
    { event: "prepared" },
    operatorId,
  );
}

/**
 * The recovery (Р12), at start and whenever the label is read again: every
 * job of the pairing left in `sending` that no send of this app run holds —
 * neither one in progress (`isUnitLabelSendActive`, from before its `sending`
 * to its last write) nor bytes the runtime still has — is `delivery_unknown`
 * `interrupted`: the app stopped after the bytes may have gone. Nothing is
 * sent: the operator scans the label that came out or prints it again with a
 * reason. A job that moved meanwhile is left as it is; a job whose step fails
 * stops none of the others, and the first such failure is thrown after them.
 * `operatorId` may be `null`: nobody may be signed in at the start.
 */
export async function recoverUnitLabels(
  context: UnitLabelPrintContext,
  operatorId: string | null,
): Promise<UnitLabelJob[]> {
  const recovered: UnitLabelJob[] = [];
  let failure: { error: unknown } | null = null;
  for (const job of await readSendingUnitLabels(context.local, context.pairing)) {
    if (isUnitLabelSendActive(context, job.id) || context.runtime.isInFlight(job.id)) continue;
    try {
      recovered.push(
        await step(
          context,
          job,
          attempt(job, "delivery_unknown", "interrupted"),
          { event: "delivery_unknown" },
          operatorId,
        ),
      );
    } catch (error) {
      if (error instanceof StaleUnitLabelError) continue;
      failure ??= { error };
    }
  }
  if (failure !== null) throw failure.error;
  return recovered;
}
