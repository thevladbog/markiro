import type { ReceivingCsvColumn } from "@markiro/domain";
import type { ReceivingCsvPreviewInput } from "@markiro/platform-contracts";

export const csvColumns =
  "product_id,product_gtin,lot_link_mode,lot_id,tlc,source_kind,source_location_id,source_reference_url,source_resolved_location_id,quantity,unit_of_measure,exempt_supplier,exempt_reason,exempt_evidence_url,exempt_tlc_handling,proposed_tlc,supplier_lot_reference,notes";
export const csvHeader: ReceivingCsvPreviewInput["header"] = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  documentIds: [],
};
export function csvRow(
  productId: string,
  overrides: Partial<Record<ReceivingCsvColumn, string>> = {},
) {
  const cells: Record<ReceivingCsvColumn, string> = {
    product_id: productId,
    product_gtin: "",
    lot_link_mode: "create_on_finalize",
    lot_id: "",
    tlc: "=Case/Ä-001",
    source_kind: "",
    source_location_id: "",
    source_reference_url: "",
    source_resolved_location_id: "",
    quantity: "500.000",
    unit_of_measure: "lb",
    exempt_supplier: "false",
    exempt_reason: "",
    exempt_evidence_url: "",
    exempt_tlc_handling: "",
    proposed_tlc: "",
    supplier_lot_reference: "00042",
    notes: "",
    ...overrides,
  };
  return Object.values(cells)
    .map((value) => '"' + value.replaceAll('"', '""') + '"')
    .join(",");
}
export function csvRequest(rows: string[], header = csvHeader): ReceivingCsvPreviewInput {
  return {
    templateVersion: "markiro-receiving-v1",
    fileBase64: Buffer.from(csvColumns + "\n" + rows.join("\n")).toString("base64"),
    header,
  };
}
