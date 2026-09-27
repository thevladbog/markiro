import { describe, expect, it } from "vitest";
import { RECEIVING_CSV_COLUMNS } from "@markiro/domain";
import {
  parseReceivingCsvRow,
  receivingCsvApplyResponseSchema,
  receivingCsvPreviewSchema,
  matchesReceivingCsvApplyResponse,
} from "../src/index.js";
import {
  header,
  lifecycle,
  eventId,
  otherId,
  successorId,
  productId,
} from "./support/us-receiving-lifecycle-fixture.js";

const raw: Record<string, string> = {
  product_id: productId,
  lot_link_mode: "create_on_finalize",
  exempt_supplier: "false",
};
const cells = RECEIVING_CSV_COLUMNS.map((column) => raw[column] ?? "");
const row = parseReceivingCsvRow(cells);
if (!row.ok) throw new Error("Invalid CSV specimen");
const normalizedHeader = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  documentIds: [],
};
const normalizedDraft = { ...normalizedHeader, items: [row.item] };
const preview = {
  responseVersion: 1,
  id: otherId,
  templateVersion: "markiro-receiving-v1",
  fileName: null,
  byteSize: 600,
  fileSha256: "a".repeat(64),
  rowCount: 1,
  header: normalizedHeader,
  fileError: null,
  rows: [{ rowNumber: 1, lineNumber: 2, cells, issues: [], normalizations: row.normalizations }],
  resolution: {
    rows: [{ rowNumber: 1, productId: productId.toLowerCase(), issues: [] }],
    headerIssues: [],
  },
  proposedDraft: normalizedDraft,
  previewDigest: "b".repeat(64),
  createdBy: "creator",
  createdAt: header.createdAt,
  expiresAt: "2026-09-08T09:00:00.000Z",
};
const receipt = {
  receiptVersion: 1,
  command: "receiving.csv.apply",
  operationKey: otherId,
  inputDigest: "b".repeat(64),
  importId: successorId,
  eventId,
  record: {
    ...header,
    draftVersion: 1,
    updatedBy: header.createdBy,
    updatedAt: header.createdAt,
    recordVersion: 2,
    status: "draft",
    lifecycle: { ...lifecycle, lifecycleVersion: 1, currentEventId: null, pendingDraftId: eventId },
    content: { kind: "draft", draft: normalizedDraft },
  },
};
const response = {
  responseVersion: 1,
  request: { importId: otherId, operationKey: eventId, expectedPreviewDigest: "b".repeat(64) },
  receipt,
};

describe("Receiving CSV HTTP contracts", () => {
  it("preserves request correlation separately from an original receipt", () => {
    expect(receivingCsvApplyResponseSchema.parse(response)).toEqual(response);
    expect(matchesReceivingCsvApplyResponse(response, response.request)).toBe(true);
    expect(
      matchesReceivingCsvApplyResponse(response, { ...response.request, operationKey: otherId }),
    ).toBe(false);
    expect(
      matchesReceivingCsvApplyResponse(response, { ...response.request, importId: successorId }),
    ).toBe(false);
    expect(
      matchesReceivingCsvApplyResponse(response, {
        ...response.request,
        expectedPreviewDigest: "c".repeat(64),
      }),
    ).toBe(false);
  });
  it.each([
    { ...response, request: { ...response.request, expectedPreviewDigest: "c".repeat(64) } },
    { ...response, created: true },
    { ...response, receipt: { ...receipt, eventId: otherId } },
    { ...response, receipt: { ...receipt, record: { ...receipt.record, draftVersion: 2 } } },
    { ...response, receipt: { ...receipt, record: { ...receipt.record, updatedBy: "editor" } } },
  ])("rejects a mismatched or rewritten acknowledgement", (value) => {
    expect(receivingCsvApplyResponseSchema.safeParse(value).success).toBe(false);
  });
  it("returns bounded row evidence without file bytes or raw header", () => {
    expect(receivingCsvPreviewSchema.parse(preview)).toEqual(preview);
    expect(receivingCsvPreviewSchema.safeParse({ ...preview, fileBase64: "" }).success).toBe(false);
    expect(
      receivingCsvPreviewSchema.safeParse({ ...preview, originalHeader: normalizedHeader }).success,
    ).toBe(false);
  });
  it.each([
    { ...preview, rowCount: 2 },
    { ...preview, previewDigest: null },
    { ...preview, expiresAt: preview.createdAt },
    { ...preview, rows: [{ ...preview.rows[0], normalizations: [] }] },
    { ...preview, resolution: { ...preview.resolution, rows: [] } },
    { ...preview, proposedDraft: { ...normalizedDraft, items: [] } },
    { ...preview, fileError: { code: "syntax", lineNumber: 2 } },
  ])("rejects inconsistent preview evidence", (value) => {
    expect(receivingCsvPreviewSchema.safeParse(value).success).toBe(false);
  });
});
