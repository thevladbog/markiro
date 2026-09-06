import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const productId = "00000000-0000-4000-8000-000000000001";
const locationId = "00000000-0000-4000-8000-000000000002";
const documentId = "00000000-0000-4000-8000-000000000003";
const document = {
  type: "bol",
  typeOtherLabel: null,
  number: "00001",
  partyId: null,
  issuedOn: "2026-09-14",
  notes: null,
};
const emptyItem = {
  productId: null,
  lotLinkMode: "create_on_finalize",
  lotId: null,
  tlc: null,
  source: null,
  exemptSupplier: false,
  exemptReason: null,
  supplierLotReference: null,
  quantity: null,
  unitOfMeasure: null,
  notes: null,
};
const emptyDraft = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  items: [],
  documentIds: [],
};

describe("receiving draft boundary", () => {
  it("keeps incomplete drafts explicit, without inferring dates, lots or sources", () => {
    expect(contracts.receivingDraftSchema.parse(emptyDraft)).toEqual(emptyDraft);
    expect(contracts.receivingDraftItemSchema.parse(emptyItem)).toEqual(emptyItem);
    const incomplete = {
      ...emptyItem,
      exemptSupplier: true,
      quantity: "500",
      lotLinkMode: "link_existing",
    };
    expect(contracts.receivingDraftItemSchema.parse(incomplete)).toEqual(incomplete);
    expect(contracts.receivingDraftSchema.safeParse({}).success).toBe(false);
    expect(contracts.receivingDraftItemSchema.safeParse({}).success).toBe(false);
  });

  it("preserves two ordered receipt lines, quantities and opaque source identities", () => {
    const item = {
      ...emptyItem,
      productId,
      tlc: "  =Supplier-🍎  ",
      quantity: " 500.000 ",
      unitOfMeasure: "lb",
      source: {
        kind: "reference",
        referenceKind: "web_url",
        referenceValue: "https://supplier.example.test/Case/A",
        resolvedLocationId: locationId,
      },
    };
    const draft = {
      ...emptyDraft,
      dateReceived: "2026-09-14",
      locationId,
      items: [item, { ...item, tlc: "00002", quantity: "0.001" }],
      documentIds: [documentId],
    };
    const parsed = contracts.receivingDraftSchema.parse(draft);
    expect(parsed.items.map((line) => [line.tlc, line.quantity, line.unitOfMeasure])).toEqual([
      ["=Supplier-🍎", "500.000", "lb"],
      ["00002", "0.001", "lb"],
    ]);
    expect(parsed.items[0]?.source).toEqual(item.source);
    expect(parsed.dateReceived).toBe("2026-09-14");
  });

  it.each([
    { quantity: 500 },
    { quantity: "0" },
    { quantity: "1e3" },
    { quantity: "1.2345" },
    { quantity: "1000000000000000" },
    { quantity: "1,000" },
    { unitOfMeasure: "LB" },
    { unitOfMeasure: "pallet" },
    { tlc: "" },
    { tlc: "A\u0000B" },
    { productId: "wrong" },
    { exemptSupplier: "true" },
    { source: { kind: "reference", referenceValue: "https://supplier.example.test" } },
    { source: { kind: "location", locationId, tenantId: "forged" } },
    {
      source: {
        kind: "reference",
        referenceKind: "web_url",
        referenceValue: "https://user:pass@example.test",
        resolvedLocationId: locationId,
      },
    },
  ])("rejects malformed present item values: %j", (change) => {
    expect(contracts.receivingDraftItemSchema.safeParse({ ...emptyItem, ...change }).success).toBe(
      false,
    );
  });

  it.each(["2026-02-29", "2026-04-31", "09/14/2026", "2026-09-14T00:00:00Z", ""])(
    "rejects malformed present event date %s",
    (dateReceived) => {
      const result = contracts.receivingDraftSchema.safeParse({ ...emptyDraft, dateReceived });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(["dateReceived"]);
    },
  );

  it.each([
    "tenantId",
    "createdBy",
    "status",
    "finalizedAt",
    "revision",
    "snapshot",
    "assignmentBasis",
  ])("rejects client-owned %s on headers and lines", (field) => {
    expect(
      contracts.receivingDraftSchema.safeParse({ ...emptyDraft, [field]: "forged" }).success,
    ).toBe(false);
    expect(
      contracts.receivingDraftItemSchema.safeParse({ ...emptyItem, [field]: "forged" }).success,
    ).toBe(false);
  });

  it("rejects duplicate document links and oversized collections without dropping entries", () => {
    expect(
      contracts.receivingDraftSchema.safeParse({
        ...emptyDraft,
        documentIds: [documentId, documentId],
      }).success,
    ).toBe(false);
    const letterId = "abcdefab-0000-4000-8000-000000000001";
    expect(
      contracts.receivingDraftSchema.safeParse({
        ...emptyDraft,
        documentIds: [letterId, letterId.toUpperCase()],
      }).success,
    ).toBe(false);
    expect(
      contracts.receivingDraftSchema.safeParse({
        ...emptyDraft,
        items: Array.from({ length: 101 }, () => emptyItem),
      }).success,
    ).toBe(false);
    expect(
      contracts.receivingDraftSchema.parse({
        ...emptyDraft,
        items: Array.from({ length: 100 }, () => emptyItem),
      }).items,
    ).toHaveLength(100);
    const ids = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    expect(
      contracts.receivingDraftSchema.safeParse({ ...emptyDraft, documentIds: ids }).success,
    ).toBe(false);
    expect(
      contracts.receivingDraftSchema.parse({ ...emptyDraft, documentIds: ids.slice(0, 100) })
        .documentIds,
    ).toHaveLength(100);
  });
});

describe("reference document boundaries", () => {
  it.each([
    "bol",
    "po",
    "asn",
    "work_order",
    "invoice",
    "database_record",
    "batch_log",
    "production_log",
  ])("supports %s without an attachment", (type) => {
    expect(contracts.referenceDocumentInputSchema.parse({ ...document, type })).toEqual({
      ...document,
      type,
    });
  });

  it("requires other-type explanation and rejects it on a named type", () => {
    expect(
      contracts.referenceDocumentInputSchema.parse({
        ...document,
        type: "other",
        typeOtherLabel: "  Grower certificate  ",
      }).typeOtherLabel,
    ).toBe("Grower certificate");
    for (const typeOtherLabel of [null, "", " "])
      expect(
        contracts.referenceDocumentInputSchema.safeParse({
          ...document,
          type: "other",
          typeOtherLabel,
        }).success,
      ).toBe(false);
    expect(
      contracts.referenceDocumentInputSchema.safeParse({
        ...document,
        typeOtherLabel: "Certificate",
      }).success,
    ).toBe(false);
  });

  it.each(["00001", "=0001", "+001", "-001", "@0001", "BOL-Ä🍎"])(
    "preserves the identifier %s",
    (number) => {
      expect(
        contracts.referenceDocumentInputSchema.parse({ ...document, number: ` ${number} ` }).number,
      ).toBe(number);
    },
  );

  it.each([
    { number: "" },
    { number: " " },
    { number: "x".repeat(129) },
    { number: "A\u0000B" },
    { number: "A\nB" },
    { number: "A\n" },
    { number: "\tA" },
    { number: "\ud800" },
    { type: "packing_slip" },
    { partyId: "wrong" },
    { issuedOn: "2026-02-29" },
    { attachmentObjectKey: "foreign/file" },
    { tenantId: "forged" },
    { createdBy: "forged" },
    { notes: "x".repeat(2001) },
    { type: "other", typeOtherLabel: "x".repeat(201) },
    { type: "other", typeOtherLabel: "Label\u0000" },
  ])("rejects invalid document data %j", (change) => {
    expect(
      contracts.referenceDocumentInputSchema.safeParse({ ...document, ...change }).success,
    ).toBe(false);
  });

  it("reads a pinned snapshot losslessly without entry normalization", () => {
    const snapshot = {
      ...document,
      snapshotVersion: 1,
      documentId,
      number: "  =0001  ",
      type: "other",
      typeOtherLabel: "  Supplier note  ",
      notes: "  Original text\n  ",
    };
    expect(contracts.referenceDocumentSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      contracts.referenceDocumentSnapshotSchema.safeParse({ ...snapshot, snapshotVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      contracts.referenceDocumentSnapshotSchema.safeParse({ ...snapshot, documentId: "foreign" })
        .success,
    ).toBe(false);
    expect(
      contracts.referenceDocumentSnapshotSchema.safeParse({
        ...snapshot,
        attachmentObjectKey: "file",
      }).success,
    ).toBe(false);
    expect(
      contracts.referenceDocumentSnapshotSchema.safeParse({ ...snapshot, issuedOn: "1900-02-29" })
        .success,
    ).toBe(false);
  });

  it("does not normalize UUID spelling when reading a pinned snapshot", () => {
    const snapshot = {
      ...document,
      snapshotVersion: 1,
      documentId: "ABCDEFAB-0000-4000-8000-000000000001",
      partyId: "ABCDEFAB-0000-4000-8000-000000000002",
    };
    expect(contracts.referenceDocumentSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
});
