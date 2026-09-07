import { DomainError } from "../errors.js";
import type { ReceivingReadinessInput } from "./receiving-readiness.js";
import { isTlcSourceReferenceUrl } from "./lots/source.js";
import { normalizeTlc } from "./lots/tlc.js";

export type ReceivingExemptReceiptInput = {
  evidenceUrl: string | null;
  tlcHandling: "preserve_existing" | "assign_if_missing" | null;
  proposedTlc: string | null;
};

export type ReceivingExemptionLine = Pick<
  ReceivingReadinessInput["draft"]["items"][number],
  "tlc" | "source" | "lotLinkMode" | "lotId" | "exemptSupplier" | "exemptReason"
> & { exemptReceipt?: ReceivingExemptReceiptInput | null | undefined };

export type ReceivingExemptionIssue = {
  field: "exemption" | "tlc" | "source" | "lot";
  code: "required" | "format" | "lot_link_inconsistent" | "tlc_assignment_required";
  detail: "exemptReason" | "evidenceUrl" | "tlcHandling" | "proposedTlc" | null;
};

export type ReceivingExemptionAssessment = {
  path: "ordinary" | "exempt_existing_tlc" | "exempt_assigned_tlc" | null;
  effectiveTlc: string | null;
  requiresReview: boolean;
  issues: ReceivingExemptionIssue[];
};

/** Pure input assessment. This function does not assign, authorize or persist a TLC. */
export function assessReceivingExemptionLine(
  line: ReceivingExemptionLine,
  receivingLocationId: string | null,
  context?: { retainedLotId: string },
): ReceivingExemptionAssessment {
  if (!line.exemptSupplier) {
    return {
      path: "ordinary",
      effectiveTlc: line.tlc,
      requiresReview: false,
      issues: [],
    };
  }

  const issues: ReceivingExemptionIssue[] = [];
  const exemptReceipt = line.exemptReceipt;
  if (!line.exemptReason?.trim())
    issues.push({ field: "exemption", code: "required", detail: "exemptReason" });
  if (exemptReceipt?.evidenceUrl === null || exemptReceipt?.evidenceUrl === undefined)
    issues.push({ field: "exemption", code: "required", detail: "evidenceUrl" });
  else if (!isTlcSourceReferenceUrl(exemptReceipt.evidenceUrl))
    issues.push({ field: "exemption", code: "format", detail: "evidenceUrl" });

  const tlcHandling = exemptReceipt?.tlcHandling;
  if (tlcHandling === null || tlcHandling === undefined) {
    issues.push({ field: "exemption", code: "required", detail: "tlcHandling" });
    return { path: null, effectiveTlc: null, requiresReview: true, issues };
  }

  const proposedTlc = exemptReceipt?.proposedTlc ?? null;
  if (tlcHandling === "preserve_existing") {
    if (proposedTlc !== null)
      issues.push({ field: "exemption", code: "format", detail: "proposedTlc" });
    return {
      path: "exempt_existing_tlc",
      effectiveTlc: line.tlc,
      requiresReview: true,
      issues,
    };
  }

  if (line.tlc !== null) issues.push({ field: "tlc", code: "format", detail: null });
  if (proposedTlc === null) {
    issues.push({ field: "tlc", code: "tlc_assignment_required", detail: "proposedTlc" });
  } else {
    try {
      if (normalizeTlc(proposedTlc) !== proposedTlc)
        issues.push({ field: "tlc", code: "format", detail: "proposedTlc" });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      issues.push({ field: "tlc", code: "format", detail: "proposedTlc" });
    }
  }
  // A validated retained binding keeps the original assignment site, even when
  // correcting the receipt header. It never assigns a TLC at a new location.
  const isRetained =
    context !== undefined && context.retainedLotId !== "" && context.retainedLotId === line.lotId;
  if (
    receivingLocationId === null ||
    line.source?.kind !== "location" ||
    (!isRetained && line.source.locationId !== receivingLocationId)
  )
    issues.push({ field: "source", code: "format", detail: null });
  // Only a validated predecessor binding permits an already assigned lot ID.
  // Received TLC, original mode/source, evidence and fresh review still apply.
  if (line.lotLinkMode !== "create_on_finalize" || (!isRetained && line.lotId !== null))
    issues.push({ field: "lot", code: "lot_link_inconsistent", detail: null });

  return {
    path: "exempt_assigned_tlc",
    effectiveTlc: proposedTlc,
    requiresReview: true,
    issues,
  };
}
