import { describe, expect, it } from "vitest";
import {
  decodeReceivingCsvExport,
  encodeReceivingCsvExport,
  receivingCsvExportQuerySchema,
  ReceivingCsvExportError,
} from "../src/traceability/receiving-csv-export.js";
import {
  draft,
  documentId,
  eventId,
  header,
  lifecycle,
  liveFinalized,
  lotId,
  productId,
  snapshotV1,
  snapshotV2,
  sourceLocationId,
  successorId,
} from "./support/us-receiving-lifecycle-fixture.js";

const capturedAt = "2026-09-25T00:00:00.000Z";
const liveDraft = {
  ...header,
  recordVersion: 2 as const,
  status: "draft" as const,
  lifecycle: {
    ...lifecycle,
    lifecycleVersion: 1,
    currentEventId: null,
    pendingDraftId: eventId,
  },
  content: { kind: "draft" as const, draft },
};

describe("Receiving saved-record CSV export", () => {
  it.each([
    ["draft", liveDraft],
    ["finalized", liveFinalized],
  ] as const)("round trips the exact %s revision", (_, record) => {
    const bytes = encodeReceivingCsvExport(record, capturedAt);
    expect(bytes.slice(0, 3)).toEqual(Uint8Array.of(0xef, 0xbb, 0xbf));
    expect(decodeReceivingCsvExport(bytes)).toEqual({ record, capturedAt });
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toContain(
      '"text:markiro-receiving-export-v1"',
    );
  });

  it("keeps leading zeroes, formula-looking text and actual versus escaped line breaks", () => {
    const record = {
      ...liveDraft,
      content: {
        kind: "draft" as const,
        draft: {
          ...draft,
          items: [
            {
              productId,
              lotLinkMode: "link_existing" as const,
              lotId,
              tlc: "=Case/Ä-001",
              source: {
                kind: "reference" as const,
                referenceKind: "web_url" as const,
                referenceValue: "https://supplier.example.test/Case/A",
                resolvedLocationId: sourceLocationId,
              },
              exemptSupplier: false,
              exemptReason: null,
              supplierLotReference: "00042",
              quantity: "500.000",
              unitOfMeasure: "lb" as const,
              notes: "literal \\n then real\nnewline and @cmd",
            },
          ],
          documentIds: [documentId],
        },
      },
    };
    const bytes = encodeReceivingCsvExport(record, capturedAt);
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(csv).toContain('"text:00042"');
    expect(csv).toContain('"text:=Case/Ä-001"');
    expect(decodeReceivingCsvExport(bytes).record).toEqual(record);
  });

  it.each([snapshotV1, snapshotV2])("preserves historical snapshot version", (snapshot) => {
    const record = {
      ...liveFinalized,
      content: { ...liveFinalized.content, snapshot },
    };
    expect(decodeReceivingCsvExport(encodeReceivingCsvExport(record, capturedAt)).record).toEqual(
      record,
    );
  });

  it("does not conflate cancelled draft, amendment draft and voided frozen revision", () => {
    const cancelled = {
      ...liveDraft,
      status: "void" as const,
      lifecycle: {
        ...liveDraft.lifecycle,
        pendingDraftId: null,
        voidReason: "Duplicate receipt",
        voidedAt: "2026-09-25T00:00:00.000Z",
        voidedBy: "qa-user",
      },
    };
    const amendment = {
      ...liveDraft,
      id: successorId,
      revision: 2,
      lifecycle: {
        ...liveDraft.lifecycle,
        rootId: eventId,
        previousRevisionId: eventId,
        currentEventId: eventId,
        pendingDraftId: successorId,
        amendmentReason: "Correct receipt",
      },
    };
    const voidedFrozen = {
      ...liveFinalized,
      status: "void" as const,
      lifecycle: {
        ...liveFinalized.lifecycle,
        currentEventId: null,
        voidReason: "Duplicate receipt",
        voidedAt: "2026-09-25T00:00:00.000Z",
        voidedBy: "qa-user",
      },
    };
    for (const record of [cancelled, amendment, voidedFrozen])
      expect(decodeReceivingCsvExport(encodeReceivingCsvExport(record, capturedAt)).record).toEqual(
        record,
      );
  });

  it("rejects a changed convenience value, extra row and invalid UTF-8", () => {
    const original = encodeReceivingCsvExport(liveFinalized, capturedAt);
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(original);
    const changed = csv.replace('"text:500.000"', '"text:500.001"');
    expect(changed).not.toBe(csv);
    expect(() => decodeReceivingCsvExport(new TextEncoder().encode(changed))).toThrow(
      ReceivingCsvExportError,
    );
    expect(() => decodeReceivingCsvExport(new TextEncoder().encode(`${csv}\r\n`))).toThrow(
      ReceivingCsvExportError,
    );
    expect(() => decodeReceivingCsvExport(Uint8Array.of(0xef, 0xbb, 0xbf, 0xff))).toThrow(
      ReceivingCsvExportError,
    );
  });

  it("keeps all 100 ordered draft lines and document IDs without fabricating row IDs", () => {
    const item = {
      productId,
      lotLinkMode: "create_on_finalize" as const,
      lotId: null,
      tlc: null,
      source: null,
      exemptSupplier: false,
      exemptReason: null,
      supplierLotReference: null,
      quantity: "42.000",
      unitOfMeasure: "lb" as const,
      notes: null,
    };
    const record = {
      ...liveDraft,
      content: {
        kind: "draft" as const,
        draft: {
          ...draft,
          items: Array.from({ length: 100 }, (_, index) => ({
            ...item,
            supplierLotReference: String(index + 1).padStart(5, "0"),
          })),
          documentIds: Array.from(
            { length: 100 },
            (_, index) => `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
          ),
        },
      },
    };
    const bytes = encodeReceivingCsvExport(record, capturedAt);
    expect(decodeReceivingCsvExport(bytes).record).toEqual(record);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text.split("\r\n")).toHaveLength(203);
  });

  it("preserves an amendment line's predecessor binding and optional exemption field absence", () => {
    const record = {
      ...liveDraft,
      id: successorId,
      revision: 2,
      lifecycle: {
        ...liveDraft.lifecycle,
        previousRevisionId: eventId,
        currentEventId: eventId,
        pendingDraftId: successorId,
        amendmentReason: "Correct receipt",
      },
      content: {
        kind: "draft" as const,
        draft: {
          ...draft,
          items: [
            {
              productId,
              lotLinkMode: "link_existing" as const,
              lotId,
              tlc: "00042",
              source: null,
              exemptSupplier: false,
              exemptReason: null,
              supplierLotReference: "  zero 00042  ",
              quantity: "42.000",
              unitOfMeasure: "lb" as const,
              notes: "zero-width\u200djoiner",
              previousLineNo: 1,
            },
          ],
        },
      },
    };
    const bytes = encodeReceivingCsvExport(record, capturedAt);
    expect(decodeReceivingCsvExport(bytes).record).toEqual(record);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toContain("\\u200d");
  });

  it("fails explicitly when a valid frozen confirmation cannot fit one CSV cell", () => {
    const warning = {
      severity: "warning" as const,
      group: "documents" as const,
      line: null,
      field: "documents" as const,
      code: "required" as const,
      detail: null,
    };
    const record = {
      ...liveFinalized,
      content: {
        ...liveFinalized.content,
        snapshot: {
          ...liveFinalized.content.snapshot,
          confirmation: {
            ...liveFinalized.content.snapshot.confirmation,
            warnings: Array.from({ length: 500 }, () => warning),
          },
        },
      },
    };
    expect(() => encodeReceivingCsvExport(record, capturedAt)).toThrowError(
      expect.objectContaining({ code: "export_value_too_large", column: "payload", row: 1 }),
    );
  });

  it("requires canonical positive query versions and rejects extra fields", () => {
    expect(
      receivingCsvExportQuerySchema.parse({
        expectedDraftVersion: "7",
        expectedLifecycleVersion: "2",
      }),
    ).toEqual({ expectedDraftVersion: 7, expectedLifecycleVersion: 2 });
    for (const query of [
      { expectedDraftVersion: "07", expectedLifecycleVersion: "2" },
      { expectedDraftVersion: "7", expectedLifecycleVersion: "0" },
      { expectedDraftVersion: "7", expectedLifecycleVersion: "2", extra: "1" },
    ])
      expect(receivingCsvExportQuerySchema.safeParse(query).success).toBe(false);
  });
});
