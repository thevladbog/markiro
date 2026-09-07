import { DomainError } from "../errors.js";
import { isTraceabilityCivilDate } from "./civil-date.js";
import {
  validateLocationDescription,
  type LocationDescriptionInput,
  type TraceabilityLocationRole,
} from "./location-description.js";
import { isTlcSourceReferenceUrl } from "./lots/source.js";
import { normalizeTlc } from "./lots/tlc.js";
import { assessCoverageReview, type CoverageReviewRecord } from "./products/coverage.js";
import type { ProductDescriptionInput } from "./products/description.js";
import { buildProductSnapshot } from "./products/snapshot.js";
import { parseTraceabilityProfile } from "./profile.js";
import { parseTraceabilityQuantity } from "./quantity.js";
import { isTraceabilityUom } from "./uom.js";
import {
  assessReceivingExemptionLine,
  type ReceivingExemptReceiptInput,
} from "./receiving-exemption.js";

export const RECEIVING_READINESS_RULE_VERSION = "receiving-readiness-v3";
export const RECEIVING_READINESS_FIELDS = [
  "dateReceived",
  "location",
  "previousSource",
  "items",
  "product",
  "coverage",
  "tlc",
  "source",
  "quantity",
  "unitOfMeasure",
  "lot",
  "exemption",
  "documents",
] as const;
export const RECEIVING_READINESS_CODES = [
  "required",
  "format",
  "unavailable",
  "inactive",
  "incomplete_description",
  "wrong_role",
  "coverage_unresolved",
  "not_assessed",
  "lot_product_mismatch",
  "lot_tlc_mismatch",
  "lot_source_mismatch",
  "lot_link_inconsistent",
  "duplicate_identity",
  "exemption_review_required",
  "tlc_assignment_required",
] as const;
export const RECEIVING_READINESS_DETAILS = [
  "businessName",
  "phoneNumber",
  "addressKind",
  "streetAddress",
  "latitude",
  "longitude",
  "city",
  "stateOrRegion",
  "zipOrPostalCode",
  "countryCode",
  "productName",
  "brandName",
  "commodity",
  "variety",
  "packagingSizeValue",
  "packagingSizeUom",
  "packagingStyle",
  "defaultQuantityUom",
  "gtin",
  "coverageStatus",
  "coverageRationale",
  "ftlCategory",
  "ftlSourceUrl",
  "ftlSourceVersion",
  "reviewedBy",
  "reviewedAt",
  "exemptReason",
  "evidenceUrl",
  "tlcHandling",
  "proposedTlc",
] as const;
export type ReceivingReadinessIssue = {
  severity: "error" | "warning";
  group: "header" | "lines" | "documents";
  line: number | null;
  field: (typeof RECEIVING_READINESS_FIELDS)[number];
  code: (typeof RECEIVING_READINESS_CODES)[number];
  detail: (typeof RECEIVING_READINESS_DETAILS)[number] | null;
};
type Source =
  | null
  | { kind: "location"; locationId: string }
  | {
      kind: "reference";
      referenceKind: "web_url";
      referenceValue: string;
      resolvedLocationId: string;
    };
export interface ReceivingReadinessInput {
  profileCode: string;
  draft: {
    dateReceived: string | null;
    locationId: string | null;
    previousSourceLocationId: string | null;
    documentIds: string[];
    items: {
      productId: string | null;
      lotId: string | null;
      lotLinkMode: "create_on_finalize" | "link_existing";
      tlc: string | null;
      source: Source;
      quantity: string | null;
      unitOfMeasure: string | null;
      exemptSupplier: boolean;
      exemptReason: string | null;
      exemptReceipt?: ReceivingExemptReceiptInput | null | undefined;
    }[];
  };
  products: {
    id: string;
    archived: boolean;
    gtin14: string | null;
    description: ProductDescriptionInput;
    coverage: CoverageReviewRecord;
  }[];
  locations: {
    id: string;
    archived: boolean;
    partyArchived: boolean;
    roles: TraceabilityLocationRole[];
    description: LocationDescriptionInput;
  }[];
  lots: { id: string; productId: string; tlc: string; source: Source; status: string }[];
  documents: { id: string; archived: boolean; type: string; number: string }[];
  /** One-based create-mode lines whose identity already exists in this tenant. */
  conflictingCreateLines: number[];
}

function sourceIdentity(source: Source): string {
  return JSON.stringify(
    source?.kind === "location"
      ? [source.kind, source.locationId]
      : source?.kind === "reference"
        ? [source.kind, source.referenceKind, source.referenceValue]
        : null,
  );
}
function sameSource(a: Source, b: Source): boolean {
  return (
    sourceIdentity(a) === sourceIdentity(b) &&
    (a?.kind !== "reference" ||
      (b?.kind === "reference" && a.resolvedLocationId === b.resolvedLocationId))
  );
}

/** Pure saved-data assessment. No persistence, QA approval, identity assignment or finalization. */
export function assessReceivingReadiness(input: ReceivingReadinessInput): {
  state: "complete" | "blocked";
  issues: ReceivingReadinessIssue[];
  exemptReviewRequiredLines: number[];
} {
  const profile = parseTraceabilityProfile(input.profileCode);
  if (profile === "RU_CHZ")
    throw new DomainError("traceability_profile_required", "A US profile is required.");
  const fsma = profile === "US_FSMA204_PROCESSOR";
  const issues: ReceivingReadinessIssue[] = [];
  const add = (
    group: ReceivingReadinessIssue["group"],
    line: number | null,
    field: ReceivingReadinessIssue["field"],
    code: ReceivingReadinessIssue["code"],
    detail: ReceivingReadinessIssue["detail"] = null,
    severity: ReceivingReadinessIssue["severity"] = "error",
  ) => {
    issues.push({ severity, group, line, field, code, detail });
  };
  const products = new Map(input.products.map((value) => [value.id, value]));
  const locations = new Map(input.locations.map((value) => [value.id, value]));
  const lots = new Map(input.lots.map((value) => [value.id, value]));
  const documents = new Map(input.documents.map((value) => [value.id, value]));
  const location = (
    id: string | null,
    group: "header" | "lines",
    line: number | null,
    field: "location" | "previousSource" | "source",
  ) => {
    if (id === null) {
      add(group, line, field, "required");
      return;
    }
    const value = locations.get(id);
    if (!value) {
      add(group, line, field, "unavailable");
      return;
    }
    if (value.archived || value.partyArchived) add(group, line, field, "inactive");
    for (const issue of validateLocationDescription(value.description, "export_ready"))
      add(group, line, field, "incomplete_description", issue.field);
    if (field === "location" && !value.roles.includes("receive_at"))
      add(group, line, field, "wrong_role");
  };
  const { draft } = input;
  const assessed = draft.items.map((line) => assessReceivingExemptionLine(line, draft.locationId));
  const exemptReviewRequiredLines = draft.items.flatMap((line, index) =>
    line.exemptSupplier ? [index + 1] : [],
  );
  if (draft.dateReceived === null) add("header", null, "dateReceived", "required");
  else if (!isTraceabilityCivilDate(draft.dateReceived))
    add("header", null, "dateReceived", "format");
  location(draft.locationId, "header", null, "location");
  location(draft.previousSourceLocationId, "header", null, "previousSource");
  if (!draft.items.length) add("lines", null, "items", "required");
  const createIdentities = new Map<string, number[]>();
  draft.items.forEach((row, index) => {
    const effectiveTlc = assessed[index]?.effectiveTlc ?? null;
    if (row.lotLinkMode !== "create_on_finalize" || effectiveTlc === null || row.source === null)
      return;
    const key = JSON.stringify([effectiveTlc, sourceIdentity(row.source)]);
    createIdentities.set(key, [...(createIdentities.get(key) ?? []), index + 1]);
  });
  const duplicateLines = new Set([
    ...input.conflictingCreateLines,
    ...[...createIdentities.values()].filter((lines) => lines.length > 1).flat(),
  ]);
  draft.items.forEach((row, index) => {
    const line = index + 1;
    const issue = (
      field: ReceivingReadinessIssue["field"],
      code: ReceivingReadinessIssue["code"],
      detail: ReceivingReadinessIssue["detail"] = null,
      severity: ReceivingReadinessIssue["severity"] = "error",
    ) => add("lines", line, field, code, detail, severity);
    if (row.productId === null) issue("product", "required");
    else {
      const product = products.get(row.productId);
      if (!product) issue("product", "unavailable");
      else {
        if (product.archived) issue("product", "inactive");
        const productSnapshot = buildProductSnapshot(
          { id: product.id, gtin14: product.gtin14 },
          product.description,
        );
        if (!productSnapshot.ok)
          for (const finding of productSnapshot.issues)
            if (finding.field === "gtin") issue("product", "format", "gtin");
            else issue("product", "incomplete_description", finding.field);
        if (fsma) {
          for (const finding of assessCoverageReview(product.coverage, profile).issues)
            issue("coverage", "coverage_unresolved", finding.field);
        } else issue("coverage", "not_assessed", null, "warning");
      }
    }
    const assessment = assessed[index];
    if (!assessment) throw new Error("Missing receiving assessment");
    const effectiveTlc = assessment.effectiveTlc;
    if (effectiveTlc === null) {
      if (assessment.path !== "exempt_assigned_tlc")
        issue("tlc", row.exemptSupplier ? "tlc_assignment_required" : "required");
    } else {
      try {
        if (normalizeTlc(effectiveTlc) !== effectiveTlc) issue("tlc", "format");
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        issue("tlc", "format");
      }
    }
    const source = row.source;
    location(
      source?.kind === "location" ? source.locationId : (source?.resolvedLocationId ?? null),
      "lines",
      line,
      "source",
    );
    if (source?.kind === "reference" && !isTlcSourceReferenceUrl(source.referenceValue))
      issue("source", "format");
    if (row.quantity === null) issue("quantity", "required");
    else {
      try {
        if (parseTraceabilityQuantity(row.quantity) !== row.quantity) issue("quantity", "format");
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        issue("quantity", "format");
      }
    }
    if (row.unitOfMeasure === null) issue("unitOfMeasure", "required");
    else if (!isTraceabilityUom(row.unitOfMeasure)) issue("unitOfMeasure", "format");
    if (row.lotLinkMode === "link_existing") {
      if (row.lotId === null) issue("lot", "required");
      else {
        const lot = lots.get(row.lotId);
        if (!lot) issue("lot", "unavailable");
        else {
          if (lot.status !== "active") issue("lot", "inactive");
          if (lot.productId !== row.productId) issue("lot", "lot_product_mismatch");
          if (lot.tlc !== effectiveTlc) issue("lot", "lot_tlc_mismatch");
          if (!sameSource(lot.source, row.source)) issue("lot", "lot_source_mismatch");
        }
      }
    } else {
      if (row.lotId !== null) issue("lot", "lot_link_inconsistent");
      if (duplicateLines.has(line)) issue("lot", "duplicate_identity");
    }
    for (const finding of assessment.issues) issue(finding.field, finding.code, finding.detail);
  });
  if (!draft.documentIds.length)
    add("documents", null, "documents", "required", null, fsma ? "error" : "warning");
  for (const id of draft.documentIds) {
    const document = documents.get(id);
    if (!document) add("documents", null, "documents", "unavailable");
    else if (document.archived) add("documents", null, "documents", "inactive");
    else if (!document.type.trim() || !document.number.trim())
      add("documents", null, "documents", "required");
  }
  return {
    state: issues.some((issue) => issue.severity === "error") ? "blocked" : "complete",
    issues,
    exemptReviewRequiredLines,
  };
}
