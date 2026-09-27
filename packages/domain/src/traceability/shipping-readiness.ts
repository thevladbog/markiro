import { isTraceabilityCivilDate } from "./civil-date.js";
import { assessCoverageReview, type CoverageReviewRecord } from "./products/coverage.js";
import { shippingQuantityMilli, type ShippingBalance } from "./shipping-balance.js";
import { isTraceabilityUom } from "./uom.js";

export type ShippingIssue = { code: string; path: string; line?: number };
export type ShippingReadinessInput = {
  profileCode: "US_FSMA204_PROCESSOR" | "US_GENERIC_LOT_TRACEABILITY";
  draft: {
    eventDate: string | null;
    timeZone: string | null;
    shipFromLocationId: string | null;
    recipientLocationId: string | null;
    documentIds: readonly string[];
    items: readonly {
      lotId: string | null;
      quantity: string | null;
      unitOfMeasure: string | null;
    }[];
  };
  locations: readonly {
    id: string;
    roles: readonly string[];
    archived: boolean;
    descriptionReady: boolean;
  }[];
  documents: readonly { id: string; archived: boolean; type: string; number: string }[];
  products: readonly {
    id: string;
    archived: boolean;
    descriptionReady: boolean;
    coverage: CoverageReviewRecord;
  }[];
  lots: readonly {
    id: string;
    productId: string;
    tlc: string | null;
    sourceResolved: boolean;
    status: string;
    balance: ShippingBalance;
    /** A shipped status effect held by the predecessor being replaced in this amendment. */
    predecessorShippingStatusOwned?: boolean;
  }[];
};

/** Completeness over saved draft and fresh, tenant-resolved server facts. */
export function validateShippingReadiness(input: ShippingReadinessInput): ShippingIssue[] {
  const issues: ShippingIssue[] = [];
  const add = (path: string, code: string, line?: number) =>
    issues.push(line === undefined ? { path, code } : { path, code, line });
  const { draft } = input;
  const locations = new Map(input.locations.map((value) => [value.id, value]));
  const documents = new Map(input.documents.map((value) => [value.id, value]));
  const products = new Map(input.products.map((value) => [value.id, value]));
  const lots = new Map(input.lots.map((value) => [value.id, value]));

  if (draft.eventDate === null) add("eventDate", "required");
  else if (!isTraceabilityCivilDate(draft.eventDate)) add("eventDate", "format");
  if (!draft.timeZone) add("timeZone", "required");
  else {
    try {
      new Intl.DateTimeFormat("en", { timeZone: draft.timeZone });
    } catch {
      add("timeZone", "format");
    }
  }
  const location = (id: string | null, path: string, allowedRoles: readonly string[]) => {
    if (!id) {
      add(path, "required");
      return;
    }
    const record = locations.get(id);
    if (!record) {
      add(path, "unavailable");
      return;
    }
    if (record.archived) add(path, "inactive");
    if (!record.descriptionReady) add(path, "incomplete_description");
    if (!record.roles.some((role) => allowedRoles.includes(role))) add(path, "wrong_role");
  };
  location(draft.shipFromLocationId, "shipFromLocationId", ["ship_from", "processor"]);
  location(draft.recipientLocationId, "recipientLocationId", ["recipient"]);
  if (draft.shipFromLocationId && draft.shipFromLocationId === draft.recipientLocationId)
    add("recipientLocationId", "same_location");
  if (draft.documentIds.length === 0) add("documentIds", "required");
  for (const id of draft.documentIds) {
    const document = documents.get(id);
    if (!document) add("documentIds", "unavailable");
    else if (document.archived) add("documentIds", "inactive");
    else if (!document.type.trim() || !document.number.trim())
      add("documentIds", "incomplete_description");
  }
  if (draft.items.length === 0) add("items", "required");
  const seen = new Set<string>();
  draft.items.forEach((item, index) => {
    const line = index + 1;
    const path = (field: string) => `items[${index}].${field}`;
    const candidate = item.quantity === null ? null : shippingQuantityMilli(item.quantity);
    if (item.quantity === null) add(path("quantity"), "required", line);
    else if (candidate === null) add(path("quantity"), "format", line);
    if (item.unitOfMeasure === null) add(path("unitOfMeasure"), "required", line);
    else if (!isTraceabilityUom(item.unitOfMeasure)) add(path("unitOfMeasure"), "format", line);
    if (item.lotId === null) {
      add(path("lotId"), "required", line);
      return;
    }
    if (seen.has(item.lotId)) add(path("lotId"), "duplicate", line);
    seen.add(item.lotId);
    const lot = lots.get(item.lotId);
    if (!lot) {
      add(path("lotId"), "unavailable", line);
      return;
    }
    if (
      lot.status !== "active" &&
      !(lot.status === "shipped" && lot.predecessorShippingStatusOwned)
    )
      add(path("lotId"), "status_blocked", line);
    if (!lot.tlc?.trim()) add(path("tlc"), "required", line);
    if (!lot.sourceResolved) add(path("source"), "source_unresolved", line);
    const product = products.get(lot.productId);
    if (!product) add(path("productId"), "unavailable", line);
    else {
      if (product.archived) add(path("productId"), "inactive", line);
      if (!product.descriptionReady) add(path("productId"), "incomplete_description", line);
      if (input.profileCode === "US_FSMA204_PROCESSOR") {
        const review = assessCoverageReview(product.coverage, input.profileCode);
        if (
          review.state !== "reviewed" ||
          !["covered", "contains_ftl_same_form"].includes(product.coverage.coverageStatus)
        )
          add(path("coverage"), "coverage_unresolved", line);
      }
    }
    const balance = lot.balance;
    if (balance.state === "unknown") {
      if (balance.reason === "no_current_origin") add(path("origin"), "origin_missing", line);
      add(path("quantity"), "balance_unknown", line);
      return;
    }
    if (
      item.unitOfMeasure &&
      isTraceabilityUom(item.unitOfMeasure) &&
      item.unitOfMeasure !== balance.unitOfMeasure
    )
      add(path("unitOfMeasure"), "uom_mismatch", line);
    // Balance strings are produced by computeShippingBalance; parse their exact decimal scale here.
    const exactRemaining = decimalMilli(balance.remaining);
    if (exactRemaining === null) add(path("quantity"), "balance_unknown", line);
    else if (exactRemaining <= 0n) add(path("quantity"), "balance_exhausted", line);
    else if (
      candidate !== null &&
      item.unitOfMeasure === balance.unitOfMeasure &&
      candidate > exactRemaining
    )
      add(path("quantity"), "over_shipment", line);
  });
  return issues;
}

function decimalMilli(value: string): bigint | null {
  const match = /^(-?)(0|[1-9]\d{0,14})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const whole = match[2];
  if (whole === undefined) return null;
  const amount = BigInt(whole) * 1000n + BigInt((match[3] ?? "").padEnd(3, "0"));
  return match[1] === "-" ? -amount : amount;
}
