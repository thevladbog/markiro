import { DomainError } from "../errors.js";
import { isTraceabilityCivilDate } from "./civil-date.js";
import { parseTraceabilityQuantity } from "./quantity.js";
import { isTraceabilityUom, type TraceabilityUom } from "./uom.js";
import { assessCoverageReview, type CoverageReviewRecord } from "./products/coverage.js";

export const TRANSFORMATION_READINESS_RULE_VERSION = "transformation-readiness-v1";
export type TransformationDraftValue = {
  eventDate: string | null;
  processorLocationId: string | null;
  reason: "commingling_and_repacking" | "repacking" | "relabeling" | "processing" | "other" | null;
  reasonNote: string | null;
  notes: string | null;
  inputs: Array<
    | {
        kind: "ftl_lot";
        lotId: string | null;
        quantity: string | null;
        unitOfMeasure: TraceabilityUom | null;
      }
    | {
        kind: "non_ftl";
        productId: string | null;
        sourceLocationId: string | null;
        reference: string | null;
        quantity: string | null;
        unitOfMeasure: TraceabilityUom | null;
      }
  >;
  outputs: Array<{
    productId: string | null;
    tlc: string | null;
    quantity: string | null;
    unitOfMeasure: TraceabilityUom | null;
  }>;
  documentIds: string[];
};
export type TransformationIssue = {
  severity: "error";
  group: "event" | "inputs" | "outputs" | "documents";
  line: number | null;
  field: string;
  code: string;
  detail: string | null;
};
export type TransformationReadinessInput = {
  profileCode: "US_FSMA204_PROCESSOR" | "US_GENERIC_LOT_TRACEABILITY";
  draft: TransformationDraftValue;
  products: readonly {
    id: string;
    archived: boolean;
    coverage: CoverageReviewRecord;
    descriptionReady: boolean;
  }[];
  locations: readonly {
    id: string;
    roles: readonly string[];
    archived: boolean;
    descriptionReady: boolean;
  }[];
  lots: readonly {
    id: string;
    productId: string;
    tlc: string | null;
    sourceResolved: boolean;
    currentOrigin: boolean;
  }[];
  documents: readonly { id: string; archived: boolean; type: string; number: string }[];
};

/** Deterministic completeness checks over facts resolved by the server. */
export function assessTransformationReadiness(
  input: TransformationReadinessInput,
): TransformationIssue[] {
  const issues: TransformationIssue[] = [];
  const add = (
    group: TransformationIssue["group"],
    line: number | null,
    field: string,
    code: string,
    detail: string | null = null,
  ) => issues.push({ severity: "error", group, line, field, code, detail });
  const products = new Map(input.products.map((value) => [value.id, value]));
  const locations = new Map(input.locations.map((value) => [value.id, value]));
  const lots = new Map(input.lots.map((value) => [value.id, value]));
  const documents = new Map(input.documents.map((value) => [value.id, value]));
  const coverageReady = (
    product: TransformationReadinessInput["products"][number],
    expected: "ftl" | "non_ftl",
  ) => {
    const review = assessCoverageReview(product.coverage, input.profileCode);
    return (
      review.state === "reviewed" &&
      (expected === "ftl"
        ? product.coverage.coverageStatus === "covered" ||
          product.coverage.coverageStatus === "contains_ftl_same_form"
        : product.coverage.coverageStatus === "not_covered")
    );
  };
  const { draft } = input;
  if (input.profileCode !== "US_FSMA204_PROCESSOR")
    add("event", null, "profileCode", "profile_required");
  if (draft.eventDate === null) add("event", null, "eventDate", "required");
  else if (!isTraceabilityCivilDate(draft.eventDate)) add("event", null, "eventDate", "format");
  if (draft.processorLocationId === null) add("event", null, "processorLocationId", "required");
  else {
    const location = locations.get(draft.processorLocationId);
    if (!location) add("event", null, "processorLocationId", "unavailable");
    else {
      if (location.archived) add("event", null, "processorLocationId", "inactive");
      if (!location.roles.includes("processor"))
        add("event", null, "processorLocationId", "wrong_role");
      if (!location.descriptionReady)
        add("event", null, "processorLocationId", "incomplete_description");
    }
  }
  if (draft.reason === null) add("event", null, "reason", "required");
  if (draft.reason === "other" && !draft.reasonNote?.trim())
    add("event", null, "reasonNote", "required");
  const quantity = (
    group: "inputs" | "outputs",
    line: number,
    value: string | null,
    unit: TraceabilityUom | null,
  ) => {
    if (value === null) add(group, line, "quantity", "required");
    else
      try {
        if (parseTraceabilityQuantity(value) !== value) add(group, line, "quantity", "format");
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        add(group, line, "quantity", "format");
      }
    if (unit === null) add(group, line, "unitOfMeasure", "required");
    else if (!isTraceabilityUom(unit)) add(group, line, "unitOfMeasure", "format");
  };
  if (!draft.inputs.length) add("inputs", null, "inputs", "required");
  const seenLotIds = new Set<string>();
  draft.inputs.forEach((row, index) => {
    const line = index + 1;
    if (row.kind === "ftl_lot") {
      if (row.lotId === null) add("inputs", line, "lotId", "required");
      else {
        if (seenLotIds.has(row.lotId)) add("inputs", line, "lotId", "duplicate");
        seenLotIds.add(row.lotId);
        const lot = lots.get(row.lotId);
        if (!lot) add("inputs", line, "lotId", "unavailable");
        else {
          if (!lot.tlc) add("inputs", line, "tlc", "required");
          if (!lot.sourceResolved) add("inputs", line, "source", "unresolved");
          if (!lot.currentOrigin) add("inputs", line, "origin", "unresolved");
          const product = products.get(lot.productId);
          if (!product) add("inputs", line, "productId", "unavailable");
          else {
            if (product.archived) add("inputs", line, "productId", "inactive");
            if (!product.descriptionReady)
              add("inputs", line, "productId", "incomplete_description");
            if (!coverageReady(product, "ftl"))
              add("inputs", line, "coverage", "coverage_unresolved");
          }
        }
      }
    } else {
      if (row.productId === null) add("inputs", line, "productId", "required");
      else {
        const product = products.get(row.productId);
        if (!product) add("inputs", line, "productId", "unavailable");
        else {
          if (product.archived) add("inputs", line, "productId", "inactive");
          if (!product.descriptionReady) add("inputs", line, "productId", "incomplete_description");
          if (!coverageReady(product, "non_ftl"))
            add("inputs", line, "coverage", "coverage_unresolved");
        }
      }
      if (row.sourceLocationId === null) add("inputs", line, "sourceLocationId", "required");
      else {
        const source = locations.get(row.sourceLocationId);
        if (!source) add("inputs", line, "sourceLocationId", "unavailable");
        else if (source.archived || !source.descriptionReady)
          add(
            "inputs",
            line,
            "sourceLocationId",
            source.archived ? "inactive" : "incomplete_description",
          );
      }
      if (!row.reference?.trim()) add("inputs", line, "reference", "required");
    }
    quantity("inputs", line, row.quantity, row.unitOfMeasure);
  });
  if (!draft.outputs.length) add("outputs", null, "outputs", "required");
  draft.outputs.forEach((row, index) => {
    const line = index + 1;
    if (row.productId === null) add("outputs", line, "productId", "required");
    else {
      const product = products.get(row.productId);
      if (!product) add("outputs", line, "productId", "unavailable");
      else {
        if (product.archived) add("outputs", line, "productId", "inactive");
        if (!product.descriptionReady) add("outputs", line, "productId", "incomplete_description");
        if (!coverageReady(product, "ftl")) add("outputs", line, "coverage", "coverage_unresolved");
      }
    }
    if (!row.tlc?.trim()) add("outputs", line, "tlc", "required");
    quantity("outputs", line, row.quantity, row.unitOfMeasure);
  });
  if (!draft.documentIds.length) add("documents", null, "documentIds", "required");
  for (const id of draft.documentIds) {
    const document = documents.get(id);
    if (!document) add("documents", null, "documentIds", "unavailable");
    else if (document.archived) add("documents", null, "documentIds", "inactive");
    else if (!document.type.trim() || !document.number.trim())
      add("documents", null, "documentIds", "incomplete_description");
  }
  const rank = { event: 0, inputs: 1, outputs: 2, documents: 3 };
  return issues.sort(
    (a, b) =>
      rank[a.group] - rank[b.group] ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.field.localeCompare(b.field, "en") ||
      a.code.localeCompare(b.code, "en"),
  );
}
