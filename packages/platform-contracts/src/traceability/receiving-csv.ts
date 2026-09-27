import {
  isValidGtin,
  normalizeToGtin14,
  RECEIVING_CSV_COLUMNS,
  type ReceivingCsvColumn,
} from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { receivingDraftItemSchema, type ReceivingDraftItem } from "./receiving.js";

export type ReceivingCsvProductSelector = { kind: "id" | "gtin"; value: string };
export interface ReceivingCsvFieldIssue {
  column: ReceivingCsvColumn | null;
  code: "column_count" | "value" | "product_selector" | "boolean" | "lot_link" | "source";
}
export type ReceivingCsvRowResult =
  | { ok: false; issues: ReceivingCsvFieldIssue[] }
  | {
      ok: true;
      raw: Record<ReceivingCsvColumn, string>;
      productSelector: ReceivingCsvProductSelector;
      item: ReceivingDraftItem;
      normalizations: { column: ReceivingCsvColumn; before: string; after: string }[];
    };

const rawSchema = z.record(z.enum(RECEIVING_CSV_COLUMNS), z.string());
const itemColumns: Record<string, ReceivingCsvColumn> = {
  productId: "product_id",
  lotId: "lot_id",
  lotLinkMode: "lot_link_mode",
  tlc: "tlc",
  source: "source_kind",
  "source.kind": "source_kind",
  "source.locationId": "source_location_id",
  "source.referenceValue": "source_reference_url",
  "source.resolvedLocationId": "source_resolved_location_id",
  quantity: "quantity",
  unitOfMeasure: "unit_of_measure",
  exemptSupplier: "exempt_supplier",
  exemptReason: "exempt_reason",
  "exemptReceipt.evidenceUrl": "exempt_evidence_url",
  "exemptReceipt.tlcHandling": "exempt_tlc_handling",
  "exemptReceipt.proposedTlc": "proposed_tlc",
  supplierLotReference: "supplier_lot_reference",
  notes: "notes",
};

/** Input conversion only: selectors still need tenant-scoped resolution and authorization. */
export function parseReceivingCsvRow(cells: readonly string[]): ReceivingCsvRowResult {
  if (cells.length !== RECEIVING_CSV_COLUMNS.length)
    return { ok: false, issues: [{ column: null, code: "column_count" }] };
  const parsedRaw = rawSchema.safeParse(
    Object.fromEntries(RECEIVING_CSV_COLUMNS.map((column, index) => [column, cells[index]])),
  );
  if (!parsedRaw.success) return { ok: false, issues: [{ column: null, code: "value" }] };
  const raw = parsedRaw.data;
  const issues: ReceivingCsvFieldIssue[] = [];
  const issue = (column: ReceivingCsvColumn, code: ReceivingCsvFieldIssue["code"]) =>
    issues.push({ column, code });
  let productSelector: ReceivingCsvProductSelector | null = null;
  if (Boolean(raw.product_id) === Boolean(raw.product_gtin)) {
    issue("product_id", "product_selector");
    issue("product_gtin", "product_selector");
  } else if (raw.product_id) {
    const id = platformUuidSchema.safeParse(raw.product_id);
    if (!id.success) issue("product_id", "value");
    else productSelector = { kind: "id", value: id.data };
  } else if (!isValidGtin(raw.product_gtin)) issue("product_gtin", "value");
  else productSelector = { kind: "gtin", value: normalizeToGtin14(raw.product_gtin) };

  if (raw.exempt_supplier !== "true" && raw.exempt_supplier !== "false")
    issue("exempt_supplier", "boolean");
  if (raw.lot_link_mode !== "create_on_finalize" && raw.lot_link_mode !== "link_existing")
    issue("lot_link_mode", "lot_link");
  else if ((raw.lot_link_mode === "link_existing") !== Boolean(raw.lot_id))
    issue("lot_id", "lot_link");

  let source: unknown = null;
  if (raw.source_kind === "location") {
    if (raw.source_reference_url || raw.source_resolved_location_id) issue("source_kind", "source");
    source = { kind: "location", locationId: raw.source_location_id };
  } else if (raw.source_kind === "reference") {
    if (raw.source_location_id) issue("source_kind", "source");
    source = {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: raw.source_reference_url,
      resolvedLocationId: raw.source_resolved_location_id,
    };
  } else if (
    raw.source_kind ||
    raw.source_location_id ||
    raw.source_reference_url ||
    raw.source_resolved_location_id
  )
    issue("source_kind", "source");

  const nullable = (value: string) => (value === "" ? null : value);
  const parsed = receivingDraftItemSchema.safeParse({
    productId: productSelector?.kind === "id" ? productSelector.value : null,
    lotLinkMode: raw.lot_link_mode,
    lotId: nullable(raw.lot_id),
    tlc: nullable(raw.tlc),
    source,
    quantity: nullable(raw.quantity),
    unitOfMeasure: nullable(raw.unit_of_measure),
    exemptSupplier: raw.exempt_supplier === "true",
    exemptReason: nullable(raw.exempt_reason),
    exemptReceipt:
      raw.exempt_evidence_url || raw.exempt_tlc_handling || raw.proposed_tlc
        ? {
            evidenceUrl: nullable(raw.exempt_evidence_url),
            tlcHandling: nullable(raw.exempt_tlc_handling),
            proposedTlc: nullable(raw.proposed_tlc),
          }
        : null,
    supplierLotReference: nullable(raw.supplier_lot_reference),
    notes: nullable(raw.notes),
  });
  if (!parsed.success)
    for (const error of parsed.error.issues) {
      const column = itemColumns[error.path.join(".")] ?? null;
      if (!issues.some((existing) => existing.column === column))
        issues.push({ column, code: "value" });
    }
  if (!parsed.success || !productSelector || issues.length) return { ok: false, issues };
  const item = parsed.data;
  const normalizations: { column: ReceivingCsvColumn; before: string; after: string }[] = [];
  const compare = (column: ReceivingCsvColumn, value: string | null | undefined) => {
    if (value !== null && value !== undefined && raw[column] !== value)
      normalizations.push({ column, before: raw[column], after: value });
  };
  compare(productSelector.kind === "id" ? "product_id" : "product_gtin", productSelector.value);
  compare("lot_id", item.lotId);
  if (item.source?.kind === "location") compare("source_location_id", item.source.locationId);
  if (item.source?.kind === "reference") {
    compare("source_reference_url", item.source.referenceValue);
    compare("source_resolved_location_id", item.source.resolvedLocationId);
  }
  compare("tlc", item.tlc);
  compare("quantity", item.quantity);
  compare("exempt_reason", item.exemptReason);
  compare("exempt_evidence_url", item.exemptReceipt?.evidenceUrl);
  compare("proposed_tlc", item.exemptReceipt?.proposedTlc);
  compare("supplier_lot_reference", item.supplierLotReference);
  compare("notes", item.notes);
  return { ok: true, raw, productSelector, item, normalizations };
}
