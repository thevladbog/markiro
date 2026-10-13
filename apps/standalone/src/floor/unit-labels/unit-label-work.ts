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
  readUnresolvedUnitLabel,
  type UnitLabelJob,
  type UnitLabelMove,
} from "./unit-label-store.js";

/*
 * The station's unit labels (plan РЕЖ part B, task B5; Р12–Р14; migration
 * `0015`): the Data Matrix duplicate of each unit a validation shift accepts,
 * by the domain's machine (`packages/domain/src/product-labels`) without the
 * cloud's offline grants. Every step of a job is ONE transaction of its guarded
 * `MOVE_JOB_SQL` and its `unit_label` record, so the row and the host's trace
 * never differ, and a job moved meanwhile changes nothing (`StaleUnitLabelError`).
 * The full code lives only in the job's fields and bytes; the records carry
 * its hash and the digests.
 */

/**
 * Why a unit is not accepted, or a label not printed again, before anything
 * is written: no duplicate printer is assigned (`printer_unconfigured`, as the
 * cloud answers `error: "printer"`), the label does not render
 * (`render_failed`), the code has no crypto tail to duplicate
 * (`incomplete_km`, the domain's `parseDuplicateKm`), the station's one
 * unresolved job waits for the operator (`unresolved`: its check, its send or
 * its decision), or that job belongs to another shift (`another_shift`).
 */
export type UnitLabelRefusal =
  "printer_unconfigured" | "render_failed" | "incomplete_km" | "unresolved" | "another_shift";

/** A unit or a reprint refused before any write; `job` — the unresolved job in the way. */
export class UnitLabelRefusedError extends Error {
  readonly code: UnitLabelRefusal;
  readonly job: UnitLabelJob | null;
  constructor(code: UnitLabelRefusal, job: UnitLabelJob | null = null) {
    super(`unit label: ${code}`);
    this.name = "UnitLabelRefusedError";
    this.code = code;
    this.job = job;
  }
}

/** A job that cannot take this action in its state (the domain refuses its event too). */
export class UnitLabelStateError extends Error {
  constructor(id: string, state: string) {
    super(`unit label job ${id} cannot do this from ${state}`);
    this.name = "UnitLabelStateError";
  }
}

/** A job that moved on since it was read: nothing was written. */
export class StaleUnitLabelError extends Error {
  constructor(id: string) {
    super(`unit label job ${id} changed meanwhile`);
    this.name = "StaleUnitLabelError";
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
export type UnitLabelGate =
  | { kind: "accept" }
  | { kind: "verify"; job: UnitLabelJob }
  | { kind: "wait"; job: UnitLabelJob; status: ProductLabelJobStatus }
  | { kind: "another_shift"; job: UnitLabelJob };

export function canAcceptNext(job: UnitLabelJob | null, shiftId: string): UnitLabelGate {
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
  operatorName: string | null;
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
 * unresolved job waits (`unresolved`, `another_shift`) or no duplicate printer
 * is assigned (`printer_unconfigured`). Answers that printer.
 */
export async function checkUnitAcceptance(
  context: Pick<UnitLabelContext, "local" | "pairing" | "shift">,
): Promise<PrinterProfile> {
  const gate = canAcceptNext(
    await readUnresolvedUnitLabel(context.local, context.pairing),
    context.shift.copy.id,
  );
  if (gate.kind === "another_shift") throw new UnitLabelRefusedError("another_shift", gate.job);
  if (gate.kind !== "accept") throw new UnitLabelRefusedError("unresolved", gate.job);
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
 * reprint sends them again, the date included.
 */
export async function acceptWithLabel(
  context: UnitLabelContext,
  unit: AcceptedUnit,
): Promise<UnitLabelJob> {
  const { local, pairing, shift } = context;
  const policy = shift.snapshot.validationPrint;
  if (policy === null) throw new Error("acceptWithLabel: the shift prints no duplicate");
  const printer = await checkUnitAcceptance(context);
  let fields: LabelFields;
  let payloadDigest: string;
  try {
    const km = parseDuplicateKm(unit.code.canonical);
    // The code printed is the code accepted: never another identity.
    if (kmHash(km) !== unit.code.codeHash) throw new UnitLabelRefusedError("incomplete_km");
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
  return stored;
}

/**
 * One step of `job` and its record in one transaction; the job as it is after
 * it. The record's error code is the event's own: the attempt's for
 * `failed_before_send` and `delivery_unknown`, the verdict for
 * `verification_rejected`, none otherwise (a check of an unknown outcome keeps
 * the attempt's code on the row, not on its event).
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
      throw new StaleUnitLabelError(job.id);
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
 * Sends a prepared attempt (Р12): the duplicate printer assigned now must
 * print the job's identity — none is `failed_before_send`
 * `printer_unconfigured`, another way of printing, language or resolution
 * `printer_changed` (the bytes are for one printer, and a reprint sends the
 * same), and nothing leaves this computer. Otherwise `sending` is written
 * before the bytes go, so a crash in between leaves `sending` for the recovery,
 * then one send through the runtime and `sent` on the shell's
 * `{ sent: true }`, else `delivery_unknown` `transport_failed`: the domain has
 * no failure after `sending` (as the cloud, which records any failed send so),
 * and a label may exist. Nothing here sends again by itself: only a prepared
 * attempt is sent.
 */
export async function sendUnitLabel(
  context: UnitLabelPrintContext,
  job: UnitLabelJob,
  operatorId: string | null,
): Promise<UnitLabelJob> {
  if (job.attemptState !== "prepared") throw new UnitLabelStateError(job.id, job.attemptState);
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
    printer.dpi !== job.dpi
  ) {
    return step(
      context,
      job,
      attempt(job, "failed_before_send", "printer_changed"),
      { event: "failed_before_send" },
      operatorId,
    );
  }
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
    return step(context, sending, attempt(sending, "sent"), { event: "sent" }, operatorId);
  }
  return step(
    context,
    sending,
    attempt(sending, "delivery_unknown", "transport_failed"),
    { event: "delivery_unknown" },
    operatorId,
  );
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
 * Prints a job's label again (Р12): a new attempt with the operator's reason,
 * `prepared` with the job's own bytes — the same text, date and print identity
 * — and its check pending again under a required check; no unit more. Not
 * while its attempt is prepared or sending, and not while another job of the
 * station is unresolved (`unresolved`: one at a time). The caller sends it.
 */
export async function reprintUnitLabel(
  context: UnitLabelPrintContext,
  job: UnitLabelJob,
  reason: ReprintReason,
  operatorId: string,
): Promise<UnitLabelJob> {
  if (job.attemptState === "prepared" || job.attemptState === "sending") {
    throw new UnitLabelStateError(job.id, job.attemptState);
  }
  const unresolved = await readUnresolvedUnitLabel(context.local, context.pairing);
  if (unresolved !== null && unresolved.id !== job.id) {
    throw new UnitLabelRefusedError("unresolved", unresolved);
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
 * The recovery at start (Р12): every job of the pairing left in `sending`
 * whose bytes no send of this app run holds is `delivery_unknown`
 * `interrupted` — the app stopped after the bytes may have gone. Nothing is
 * sent: the operator scans the label that came out or prints it again with a
 * reason. `operatorId` may be `null`: nobody may be signed in at the start.
 */
export async function recoverUnitLabels(
  context: UnitLabelPrintContext,
  operatorId: string | null,
): Promise<UnitLabelJob[]> {
  const recovered: UnitLabelJob[] = [];
  for (const job of await readSendingUnitLabels(context.local, context.pairing)) {
    if (context.runtime.isInFlight(job.id)) continue;
    recovered.push(
      await step(
        context,
        job,
        attempt(job, "delivery_unknown", "interrupted"),
        { event: "delivery_unknown" },
        operatorId,
      ),
    );
  }
  return recovered;
}
