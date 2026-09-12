import { z } from "zod";
import {
  compareDuplicateKm,
  DomainError,
  type ProductLabelEvent,
  type ReprintReason,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import {
  appendProductLabelEvent,
  nextProductLabelEventBase,
  presentProductLabelJob,
  requireProductLabelJob,
} from "./store.js";
import type { ProductLabelActor, ProductLabelJobView, ProductLabelPrintingDeps } from "./types.js";
import { bindPrintDestination, readPrintDestination } from "../print-destinations.js";
import {
  outputPrinterProfile,
  serializePrinterOutput,
  type PrinterProfile,
} from "../printer-routing.js";

const activeSends = new Map<string, Promise<ProductLabelJobView>>();
const sendKey = (owner: string, jobId: string) => JSON.stringify([owner, jobId]);

export function isProductLabelSendActive(owner: string, jobId: string): boolean {
  return activeSends.has(sendKey(owner, jobId));
}

export async function sendPreparedProductLabel(
  deps: ProductLabelPrintingDeps,
  jobId: string,
): Promise<ProductLabelJobView> {
  const key = sendKey(deps.credentialOwnership, jobId);
  const existing = activeSends.get(key);
  if (existing) return existing;
  const operation = sendPreparedBody(deps, jobId);
  activeSends.set(key, operation);
  try {
    return await operation;
  } finally {
    if (activeSends.get(key) === operation) activeSends.delete(key);
  }
}

async function sendPreparedBody(
  deps: ProductLabelPrintingDeps,
  jobId: string,
): Promise<ProductLabelJobView> {
  const { exec, credentialOwnership } = deps;
  const job = await requireProductLabelJob(exec, credentialOwnership, jobId);
  if (job.projection.attemptState !== "prepared") return presentProductLabelJob(job);
  const base = nextProductLabelEventBase(job, deps);
  const printer = await bindPrintDestination(
    exec,
    {
      scope: job.credentialOwnership,
      purpose: "duplicate",
      jobId,
      attemptId: job.projection.attemptId,
    },
    outputPrinterProfile(deps),
  );
  const target = printer?.target ?? null;
  if (
    target === null ||
    !printer?.dpi ||
    printer.language !== job.projection.language ||
    printer.dpi !== job.projection.dpi
  ) {
    await appendProductLabelEvent(exec, credentialOwnership, {
      ...base,
      kind: "failed_before_send",
      errorCode: target === null || !printer?.dpi ? "printer_unconfigured" : "printer_changed",
    });
    return presentProductLabelJob(await requireProductLabelJob(exec, credentialOwnership, jobId));
  }
  const claimed = await appendProductLabelEvent(
    exec,
    credentialOwnership,
    {
      ...base,
      kind: "sending",
    },
    { recovery: deps.recovery ?? false },
  );
  if (claimed !== "applied")
    return presentProductLabelJob(await requireProductLabelJob(exec, credentialOwnership, jobId));
  // A compatible explicit choice may have won just before the sending claim.
  // Once sending is durable, the replacement statement below cannot change it.
  const claimedPrinter = await readPrintDestination(exec, {
    scope: job.credentialOwnership,
    purpose: "duplicate",
    jobId,
    attemptId: job.projection.attemptId,
  });
  if (
    !claimedPrinter ||
    claimedPrinter.language !== job.projection.language ||
    claimedPrinter.dpi !== job.projection.dpi
  )
    throw new Error("Saved print destination unavailable");
  const bytes = Uint8Array.from(atob(job.bytesBase64), (char) => char.charCodeAt(0));
  try {
    await serializePrinterOutput(claimedPrinter.target, () =>
      deps.print(claimedPrinter.target, bytes),
    );
  } catch {
    await appendProductLabelEvent(exec, credentialOwnership, {
      ...base,
      eventId: deps.newId(),
      sequence: base.sequence + 1,
      occurredAt: deps.now(),
      kind: "delivery_unknown",
      errorCode: "transport_failed",
    });
    return presentProductLabelJob(await requireProductLabelJob(exec, credentialOwnership, jobId));
  }
  // A failed result commit propagates. The durable sending claim prevents a retry from printing again.
  await appendProductLabelEvent(exec, credentialOwnership, {
    ...base,
    eventId: deps.newId(),
    sequence: base.sequence + 1,
    occurredAt: deps.now(),
    kind: "sent",
  });
  return presentProductLabelJob(await requireProductLabelJob(exec, credentialOwnership, jobId));
}

export async function changePreparedProductLabelPrinter(
  exec: SqlExecutor,
  owner: string,
  jobId: string,
  attemptId: string,
  printer: PrinterProfile,
): Promise<void> {
  const job = await requireProductLabelJob(exec, owner, jobId);
  if (
    job.ownershipConflict ||
    job.projection.attemptState !== "prepared" ||
    job.projection.attemptId !== attemptId ||
    isProductLabelSendActive(owner, jobId)
  )
    throw new Error("Print attempt unavailable");
  if (printer.language !== job.projection.language || printer.dpi !== job.projection.dpi)
    throw new Error("Incompatible printer");
  const guard = `EXISTS (SELECT 1 FROM product_label_jobs WHERE credential_ownership=? AND job_id=? AND ownership_conflict=0 AND status='prepared' AND json_extract(projection_json,'$.attemptState')='prepared' AND json_extract(projection_json,'$.attemptId')=?)`;
  const guardParams = [job.credentialOwnership, jobId, attemptId];
  const rows = await exec.all<{ profile_json: string }>(
    `INSERT INTO printer_destinations(scope,purpose,job_id,attempt_id,profile_json) SELECT ?,'duplicate',?,?,? WHERE ${guard} ON CONFLICT(scope,purpose,job_id,attempt_id) DO UPDATE SET profile_json=excluded.profile_json WHERE ${guard} AND printer_destinations.profile_json=? RETURNING profile_json`,
    [
      job.credentialOwnership,
      jobId,
      attemptId,
      JSON.stringify(printer),
      ...guardParams,
      ...guardParams,
      job.printer ? JSON.stringify(job.printer) : null,
    ],
  );
  if (rows.length !== 1) throw new Error("Print attempt changed");
}

export async function verifyProductLabel(
  exec: SqlExecutor,
  input: ProductLabelActor & {
    jobId: string;
    attemptId: string;
    credentialOwnership: string;
    raw: string;
  },
): Promise<"match" | "mismatch" | "invalid" | "stale"> {
  const job = await requireProductLabelJob(exec, input.credentialOwnership, input.jobId);
  const projection = job.projection;
  if (
    input.attemptId !== projection.attemptId ||
    projection.verificationOutcome === "verified" ||
    projection.verificationOutcome === "skipped" ||
    !(
      projection.attemptState === "delivery_unknown" ||
      (projection.attemptState === "sent" && projection.verification === "required")
    )
  )
    return "stale";
  const verdict = compareDuplicateKm(job.canonicalRaw, input.raw);
  const base = nextProductLabelEventBase(job, input);
  const event: ProductLabelEvent =
    verdict === "match"
      ? { ...base, kind: "verified", scannedPayloadDigest: projection.payloadDigest }
      : { ...base, kind: "verification_rejected", reason: verdict };
  const result = await appendProductLabelEvent(exec, input.credentialOwnership, event);
  return result === "applied" ? verdict : "stale";
}

/** A deliberate operator skip is a durable outcome, never proof of a physical scan. */
export async function skipProductLabelVerification(
  exec: SqlExecutor,
  input: ProductLabelActor & { jobId: string; attemptId: string; credentialOwnership: string },
): Promise<boolean> {
  const job = await requireProductLabelJob(exec, input.credentialOwnership, input.jobId);
  if (
    job.ownershipConflict ||
    input.attemptId !== job.projection.attemptId ||
    job.projection.status !== "awaiting_verification"
  )
    return false;
  return (
    (await appendProductLabelEvent(exec, input.credentialOwnership, {
      ...nextProductLabelEventBase(job, input),
      kind: "verification_skipped",
    })) === "applied"
  );
}

export async function prepareProductLabelReprint(
  exec: SqlExecutor,
  input: ProductLabelActor & {
    jobId: string;
    shiftId: string;
    credentialOwnership: string;
    reason: ReprintReason;
    recovery?: boolean;
    /** Explicit operator-selected replacement; absent keeps the previous destination. */
    printer?: PrinterProfile;
    /** First explicit resume of a legacy job with no historical output snapshot. */
    fallbackPrinter?: PrinterProfile | null;
  },
): Promise<string> {
  const reason = z.enum(["not_printed", "damaged", "lost"]).parse(input.reason);
  const job = await requireProductLabelJob(exec, input.credentialOwnership, input.jobId);
  if (job.shiftId !== input.shiftId)
    throw new DomainError("PRODUCT_LABEL_SHIFT_MISMATCH", "Reprint belongs to a different shift");
  if (job.projection.attemptState === "prepared" || job.projection.attemptState === "sending")
    throw new DomainError("PRODUCT_LABEL_BUSY", "The current print attempt has not finished");
  const attemptId = input.newId();
  const previousPrinter = await readPrintDestination(exec, {
    scope: job.credentialOwnership,
    purpose: "duplicate",
    jobId: input.jobId,
    attemptId: job.projection.attemptId,
  });
  const printer = input.printer ?? previousPrinter ?? input.fallbackPrinter ?? null;
  if (
    printer &&
    (printer.language !== job.projection.language || printer.dpi !== job.projection.dpi)
  )
    throw new DomainError(
      "PRODUCT_LABEL_PRINTER_CHANGED",
      "Saved bytes require the same language and resolution",
    );
  await bindPrintDestination(
    exec,
    { scope: job.credentialOwnership, purpose: "duplicate", jobId: input.jobId, attemptId },
    printer,
  );
  const event: ProductLabelEvent = {
    ...nextProductLabelEventBase(job, input),
    kind: "prepared",
    attemptId,
    attemptNo: job.projection.attemptNo + 1,
    reason,
    language: job.projection.language,
    dpi: job.projection.dpi,
    bytesDigest: job.projection.bytesDigest,
  };
  if (
    (await appendProductLabelEvent(exec, input.credentialOwnership, event, {
      recovery: input.recovery ?? false,
    })) !== "applied"
  )
    throw new DomainError(
      "PRODUCT_LABEL_STALE",
      "The print attempt changed; refresh the current label",
    );
  return attemptId;
}
