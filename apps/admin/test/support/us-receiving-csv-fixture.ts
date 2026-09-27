import { createHash } from "node:crypto";
import type { ReceivingCsvPreview, ReceivingCsvApplyResponse } from "@markiro/platform-contracts";
import { liveDraft } from "./us-receiving-command-fixture.js";

export const csvId = "a0000000-0000-4000-8000-000000000011";
export const csvKey = "a0000000-0000-4000-8000-000000000012";
export const csvProduct = "a0000000-0000-4000-8000-000000000013";
export const csvText =
  "product_id,product_gtin,lot_link_mode,lot_id,tlc,source_kind,source_location_id,source_reference_url,source_resolved_location_id,quantity,unit_of_measure,exempt_supplier,exempt_reason,exempt_evidence_url,exempt_tlc_handling,proposed_tlc,supplier_lot_reference,notes\n" +
  `${csvProduct},,create_on_finalize,,00042,,,,,5.000,lb,false,,,,,00007,\n`;
export const csvHeader = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  documentIds: [],
};
export const csvDraft = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  items: [
    {
      productId: csvProduct,
      lotLinkMode: "create_on_finalize" as const,
      lotId: null,
      tlc: "00042",
      source: null,
      exemptSupplier: false,
      exemptReason: null,
      exemptReceipt: null,
      supplierLotReference: "00007",
      quantity: "5.000",
      unitOfMeasure: "lb" as const,
      notes: null,
    },
  ],
  documentIds: [],
};
export const csvInput = {
  templateVersion: "markiro-receiving-v1" as const,
  fileBase64: Buffer.from(csvText).toString("base64"),
  header: csvHeader,
  fileName: "delivery.csv",
};
const fileSha256 = createHash("sha256").update(csvText).digest("hex");
// Frame uses the server contract's deterministic draft field order.
const orderedDraft = csvDraft;
const previewDigest = createHash("sha256")
  .update(
    JSON.stringify({
      templateVersion: csvInput.templateVersion,
      fileSha256,
      header: csvHeader,
      draft: orderedDraft,
    }),
  )
  .digest("hex");
export const csvPreview: ReceivingCsvPreview = {
  responseVersion: 1,
  id: csvId,
  templateVersion: csvInput.templateVersion,
  fileName: "delivery.csv",
  byteSize: Buffer.byteLength(csvText),
  fileSha256,
  rowCount: 1,
  header: csvHeader,
  fileError: null,
  rows: [
    {
      rowNumber: 1,
      lineNumber: 2,
      cells: [
        csvProduct,
        "",
        "create_on_finalize",
        "",
        "00042",
        "",
        "",
        "",
        "",
        "5.000",
        "lb",
        "false",
        "",
        "",
        "",
        "",
        "00007",
        "",
      ],
      issues: [],
      normalizations: [],
    },
  ],
  resolution: { rows: [{ rowNumber: 1, productId: csvProduct, issues: [] }], headerIssues: [] },
  proposedDraft: csvDraft,
  previewDigest,
  createdBy: liveDraft.createdBy,
  createdAt: "2026-09-09T10:00:00.000Z",
  expiresAt: "2026-09-10T10:00:00.000Z",
};
export const csvAck: ReceivingCsvApplyResponse = {
  responseVersion: 1,
  request: { importId: csvId, operationKey: csvKey, expectedPreviewDigest: previewDigest },
  receipt: {
    receiptVersion: 1,
    command: "receiving.csv.apply",
    importId: csvId,
    operationKey: csvKey,
    inputDigest: previewDigest,
    eventId: liveDraft.id,
    record: {
      ...liveDraft,
      updatedBy: liveDraft.createdBy,
      updatedAt: liveDraft.createdAt,
      content: { kind: "draft", draft: csvDraft },
    },
  },
};
