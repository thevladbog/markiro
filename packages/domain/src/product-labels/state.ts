import { DomainError } from "../errors.js";
import type {
  PrinterLanguage,
  ProductLabelAttemptState,
  ProductLabelEvent,
  ProductLabelEventBase,
  ProductLabelJobStatus,
  VerificationOutcome,
  VerificationPolicy,
} from "./contracts.js";

const ORIGIN_FIELDS = [
  "jobId",
  "shiftId",
  "codeHash",
  "acceptedAt",
  "policyRevision",
  "templateDigest",
  "payloadDigest",
] as const;

/** Immutable origin and print context accompany the current attempt's projection. */
export interface ProductLabelProjection extends Pick<
  ProductLabelEventBase,
  (typeof ORIGIN_FIELDS)[number]
> {
  latestSequence: number;
  attemptId: string;
  attemptNo: number;
  attemptState: ProductLabelAttemptState;
  verification: VerificationPolicy;
  verificationOutcome: VerificationOutcome;
  status: ProductLabelJobStatus;
  bytesDigest: string;
  language: PrinterLanguage;
  dpi: 203 | 300;
}

function invalidTransition(): never {
  throw new DomainError(
    "PRODUCT_LABEL_TRANSITION_INVALID",
    "Product label event does not follow the current attempt",
  );
}

export function productLabelStatus(
  attempt: ProductLabelAttemptState,
  verification: VerificationPolicy,
  verified: boolean,
): ProductLabelJobStatus {
  if (verified) {
    if (attempt !== "sent" && attempt !== "delivery_unknown") invalidTransition();
    return "completed";
  }
  switch (attempt) {
    case "prepared":
      return "prepared";
    case "sending":
      return "sending";
    case "sent":
      return verification === "required" ? "awaiting_verification" : "completed";
    case "failed_before_send":
    case "delivery_unknown":
      return "attention";
  }
}

/** Storage handles event-ID replay before calling this; only the next new event may advance. */
export function canApplyProductLabelEvent(
  current: ProductLabelProjection,
  event: ProductLabelEvent,
): boolean {
  if (
    !Number.isSafeInteger(event.sequence) ||
    event.sequence !== current.latestSequence + 1 ||
    !ORIGIN_FIELDS.every((field) => current[field] === event[field])
  )
    return false;

  if (event.kind === "prepared") {
    return (
      current.attemptState !== "sending" &&
      current.attemptState !== "prepared" &&
      event.attemptId !== current.attemptId &&
      event.attemptNo === current.attemptNo + 1 &&
      event.reason !== null &&
      event.bytesDigest === current.bytesDigest &&
      event.language === current.language &&
      event.dpi === current.dpi
    );
  }
  if (event.attemptId !== current.attemptId || current.verificationOutcome === "verified")
    return false;

  switch (event.kind) {
    case "sending":
    case "failed_before_send":
      return current.attemptState === "prepared";
    case "sent":
    case "delivery_unknown":
      return current.attemptState === "sending";
    case "verified":
    case "verification_rejected": {
      const canVerify =
        current.attemptState === "delivery_unknown" ||
        (current.attemptState === "sent" && current.verification === "required");
      return (
        canVerify &&
        (event.kind !== "verified" || event.scannedPayloadDigest === current.payloadDigest)
      );
    }
  }
}

export function applyProductLabelEvent(
  current: ProductLabelProjection | null,
  event: ProductLabelEvent,
  verification: VerificationPolicy,
): ProductLabelProjection {
  if (current === null) {
    if (
      event.kind !== "prepared" ||
      event.sequence !== 1 ||
      event.attemptNo !== 1 ||
      event.reason !== null
    )
      invalidTransition();
    return {
      jobId: event.jobId,
      shiftId: event.shiftId,
      codeHash: event.codeHash,
      acceptedAt: event.acceptedAt,
      policyRevision: event.policyRevision,
      templateDigest: event.templateDigest,
      payloadDigest: event.payloadDigest,
      bytesDigest: event.bytesDigest,
      language: event.language,
      dpi: event.dpi,
      latestSequence: 1,
      attemptId: event.attemptId,
      attemptNo: 1,
      attemptState: "prepared",
      verification,
      verificationOutcome: verification === "required" ? "pending" : "not_required",
      status: "prepared",
    };
  }
  if (current.verification !== verification || !canApplyProductLabelEvent(current, event))
    invalidTransition();
  if (event.kind === "prepared") {
    return {
      ...current,
      latestSequence: event.sequence,
      attemptId: event.attemptId,
      attemptNo: event.attemptNo,
      attemptState: "prepared",
      status: "prepared",
      verificationOutcome: verification === "required" ? "pending" : "not_required",
    };
  }

  const attemptState =
    event.kind === "verified" || event.kind === "verification_rejected"
      ? current.attemptState
      : event.kind;
  const verificationOutcome = event.kind === "verified" ? "verified" : current.verificationOutcome;
  return {
    ...current,
    latestSequence: event.sequence,
    attemptState,
    verificationOutcome,
    status: productLabelStatus(attemptState, verification, verificationOutcome === "verified"),
  };
}
