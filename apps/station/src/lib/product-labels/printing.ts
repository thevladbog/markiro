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
  const target = deps.target;
  if (
    target === null ||
    deps.dpi === null ||
    deps.language !== job.projection.language ||
    deps.dpi !== job.projection.dpi
  ) {
    await appendProductLabelEvent(exec, credentialOwnership, {
      ...base,
      kind: "failed_before_send",
      errorCode: target === null || deps.dpi === null ? "printer_unconfigured" : "printer_changed",
    });
    return presentProductLabelJob(await requireProductLabelJob(exec, credentialOwnership, jobId));
  }
  const claimed = await appendProductLabelEvent(exec, credentialOwnership, {
    ...base,
    kind: "sending",
  });
  if (claimed !== "applied")
    return presentProductLabelJob(await requireProductLabelJob(exec, credentialOwnership, jobId));
  const bytes = Uint8Array.from(atob(job.bytesBase64), (char) => char.charCodeAt(0));
  try {
    await deps.print(target, bytes);
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

export async function prepareProductLabelReprint(
  exec: SqlExecutor,
  input: ProductLabelActor & {
    jobId: string;
    shiftId: string;
    credentialOwnership: string;
    reason: ReprintReason;
  },
): Promise<string> {
  const reason = z.enum(["not_printed", "damaged", "lost"]).parse(input.reason);
  const job = await requireProductLabelJob(exec, input.credentialOwnership, input.jobId);
  if (job.shiftId !== input.shiftId)
    throw new DomainError("PRODUCT_LABEL_SHIFT_MISMATCH", "Reprint belongs to a different shift");
  if (job.projection.attemptState === "prepared" || job.projection.attemptState === "sending")
    throw new DomainError("PRODUCT_LABEL_BUSY", "The current print attempt has not finished");
  const attemptId = input.newId();
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
  if ((await appendProductLabelEvent(exec, input.credentialOwnership, event)) !== "applied")
    throw new DomainError(
      "PRODUCT_LABEL_STALE",
      "The print attempt changed; refresh the current label",
    );
  return attemptId;
}
