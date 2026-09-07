import { describe, expect, it, vi } from "vitest";
import type * as Domain from "@markiro/domain";
import * as contracts from "../src/index.js";

function at<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing fixture row ${index}`);
  return value;
}

const eventId = "ABCDEFAB-0000-4000-8000-000000000001";
const operationKey = "abcdefab-0000-4000-8000-000000000002";
const productId = "ABCDEFAB-0000-4000-8000-000000000003";
const lotId = "ABCDEFAB-0000-4000-8000-000000000004";
const receivingLocationId = "ABCDEFAB-0000-4000-8000-000000000005";
const sourceLocationId = "ABCDEFAB-0000-4000-8000-000000000006";
const issuerId = "ABCDEFAB-0000-4000-8000-000000000007";
const documentId = "ABCDEFAB-0000-4000-8000-000000000008";
const otherId = "ABCDEFAB-0000-4000-8000-000000000099";

const locationDescription = (locationId: string, businessName: string) => ({
  schemaVersion: 1 as const,
  locationId,
  partyId: issuerId,
  businessName,
  phoneNumber: "+1 509 555 0100",
  address: { kind: "street" as const, streetAddress: "100 Test Way" },
  city: "Yakima",
  stateOrRegion: "WA",
  zipOrPostalCode: "98901",
  countryCode: "US",
  countryDisplay: "United States",
});

const snapshot = {
  snapshotVersion: 1 as const,
  dateReceived: "2026-09-07",
  locationId: receivingLocationId,
  previousSourceLocationId: sourceLocationId,
  receivedAtNote: "  Door 4, morning shift  ",
  notes: "  Preserve supplier notation  ",
  profileCode: "US_FSMA204_PROCESSOR" as const,
  baselineVersion: "US-REG-2026-09-03",
  locationDescription: locationDescription(receivingLocationId, "Synthetic receiver"),
  previousSourceDescription: locationDescription(sourceLocationId, "Synthetic supplier"),
  items: [
    {
      lineNo: 1,
      productId,
      lotId,
      lotLinkMode: "create_on_finalize" as const,
      tlc: "=Case/Ä-001",
      source: {
        kind: "reference" as const,
        referenceKind: "web_url" as const,
        referenceValue: "https://supplier.example.test/Case/A",
        resolvedLocationId: sourceLocationId,
      },
      quantity: "500.000",
      unitOfMeasure: "lb" as const,
      supplierLotReference: "  Supplier lot 00001  ",
      notes: "  Original line note  ",
      productDescription: {
        snapshotVersion: 1 as const,
        sourceProductId: productId,
        productName: "Apple slices",
        brandName: "Test Orchard",
        commodity: "Apple",
        variety: "Gala",
        packagingSize: { value: "25.000", uom: "lb" as const },
        packagingStyle: "Case",
        gtin: "00000000000000",
      },
      coverage: {
        coverageStatus: "covered" as const,
        coverageRationale: "Reviewed against the pinned FTL source",
        ftlCategory: "Fresh-cut fruits",
        ftlSourceUrl: "https://www.fda.gov/example",
        ftlSourceVersion: "2026-09-03",
        reviewedBy: "qa-user",
        reviewedAt: "2026-09-07T10:00:00.000Z",
      },
      sourceDescription: locationDescription(sourceLocationId, "Synthetic supplier"),
    },
  ],
  documents: [
    {
      document: {
        snapshotVersion: 1 as const,
        documentId,
        type: "bol" as const,
        typeOtherLabel: null,
        number: "  =BOL-0001  ",
        partyId: issuerId,
        issuedOn: "2026-09-07",
        notes: "  Original document note  ",
      },
      issuer: { id: issuerId, name: "Synthetic supplier", legalName: "Supplier Farms LLC" },
    },
  ],
  confirmation: {
    ruleVersion: "receiving-readiness-v2" as const,
    inputDigest: "a".repeat(64),
    warnings: [],
  },
};

const finalized = {
  id: eventId,
  eventNumber: "REC-26-0001",
  status: "finalized" as const,
  revision: 1 as const,
  draftVersion: 7,
  timeZone: "America/Chicago",
  createdBy: "creator-user",
  updatedBy: "qa-user",
  createdAt: "2026-09-07T09:00:00.000Z",
  updatedAt: "2026-09-07T10:00:00.000Z",
  finalizedAt: "2026-09-07T10:00:00.000Z",
  finalizedBy: "qa-user",
  snapshot,
};

const savedDraft = {
  id: eventId,
  eventNumber: "REC-26-0001",
  status: "draft" as const,
  revision: 1 as const,
  draftVersion: 7,
  timeZone: "America/Chicago",
  createdBy: "creator-user",
  updatedBy: "creator-user",
  createdAt: "2026-09-07T09:00:00.000Z",
  updatedAt: "2026-09-07T09:00:00.000Z",
  draft: {
    dateReceived: null,
    locationId: receivingLocationId,
    previousSourceLocationId: null,
    receivedAtNote: null,
    notes: "  unfinished draft  ",
    items: [],
    documentIds: [],
  },
};

describe("receiving finalization contracts", () => {
  it("keeps the named historical reader lossless and rejects future snapshot fields", () => {
    expect(contracts.receivingFinalizationSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(
      contracts.receivingFinalizationSnapshotV1Schema.safeParse({ ...snapshot, snapshotVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      contracts.receivingFinalizationSnapshotSchema.safeParse({
        ...snapshot,
        confirmation: { ...snapshot.confirmation, reviewedExemptLines: [] },
      }).success,
    ).toBe(false);
  });
  it("accepts only a bounded client precondition and never client-owned finalization data", () => {
    expect(
      contracts.finalizeReceivingSchema.parse({
        operationKey: operationKey.toUpperCase(),
        expectedDraftVersion: 1,
        expectedInputDigest: "a".repeat(64),
      }),
    ).toEqual({
      operationKey,
      expectedDraftVersion: 1,
      expectedInputDigest: "a".repeat(64),
    });
    expect(
      contracts.finalizeReceivingSchema.parse({
        operationKey,
        expectedDraftVersion: 2147483647,
        expectedInputDigest: "a".repeat(64),
      }).expectedDraftVersion,
    ).toBe(2147483647);
    for (const value of [
      {
        operationKey,
        expectedDraftVersion: 1,
        expectedInputDigest: "a".repeat(64),
        actor: "forged",
      },
      { operationKey: "bad", expectedDraftVersion: 1, expectedInputDigest: "a".repeat(64) },
      { operationKey, expectedDraftVersion: 0, expectedInputDigest: "a".repeat(64) },
      { operationKey, expectedDraftVersion: 2147483648, expectedInputDigest: "a".repeat(64) },
      { operationKey, expectedDraftVersion: 1, expectedInputDigest: "A".repeat(64) },
      { operationKey, expectedDraftVersion: 1, expectedInputDigest: "a".repeat(63) },
    ])
      expect(contracts.finalizeReceivingSchema.safeParse(value).success).toBe(false);
  });

  it("reads a complete frozen result losslessly, including exact quantities and source text", () => {
    expect(contracts.receivingFinalizedRecordSchema.parse(finalized)).toEqual(finalized);
    expect(contracts.receivingRecordSchema.parse(finalized)).toEqual(finalized);
    expect(finalized.snapshot.items[0]?.quantity).toBe("500.000");
    expect(finalized.snapshot.items[0]?.tlc).toBe("=Case/Ä-001");
    expect(finalized.snapshot.documents[0]?.document.number).toBe("  =BOL-0001  ");
  });

  it("keeps the snapshot-v1 readiness rule independent from a future current rule", async () => {
    vi.resetModules();
    vi.doMock("@markiro/domain", async (importOriginal) => {
      const current = await importOriginal<typeof Domain>();
      return { ...current, RECEIVING_READINESS_RULE_VERSION: "receiving-readiness-v3" };
    });
    try {
      const historicalContracts = await import("../src/traceability/receiving-finalization.js");
      expect(historicalContracts.receivingFinalizationSnapshotSchema.parse(snapshot)).toEqual(
        snapshot,
      );
    } finally {
      vi.doUnmock("@markiro/domain");
      vi.resetModules();
    }
  });

  it("preserves a complete historical location display without re-deriving it", () => {
    const historical = {
      ...snapshot,
      locationDescription: {
        ...snapshot.locationDescription,
        countryDisplay: "United States of America",
      },
    };
    expect(contracts.receivingFinalizationSnapshotSchema.parse(historical)).toEqual(historical);
  });

  it("rejects broken frozen relationships rather than reconstructing them from live data", () => {
    const item = at(snapshot.items, 0);
    const document = at(snapshot.documents, 0);
    if (document.issuer === null) throw new Error("Expected fixture issuer");
    const invalidSnapshots = [
      {
        ...snapshot,
        locationDescription: { ...snapshot.locationDescription, locationId: otherId },
      },
      {
        ...snapshot,
        previousSourceDescription: { ...snapshot.previousSourceDescription, locationId: otherId },
      },
      {
        ...snapshot,
        items: [
          {
            ...item,
            productDescription: { ...item.productDescription, sourceProductId: otherId },
          },
        ],
      },
      { ...snapshot, items: [{ ...item, lotId: null }] },
      {
        ...snapshot,
        items: [
          {
            ...item,
            sourceDescription: { ...item.sourceDescription, locationId: otherId },
          },
        ],
      },
      { ...snapshot, items: [{ ...item, lineNo: 2 }] },
      {
        ...snapshot,
        items: [
          {
            ...item,
            coverage: { ...item.coverage, reviewedBy: null },
          },
        ],
      },
      {
        ...snapshot,
        documents: [{ ...document, issuer: { ...document.issuer, id: otherId } }],
      },
      { ...snapshot, documents: [{ ...document, issuer: null }] },
    ];
    for (const invalid of invalidSnapshots)
      expect(contracts.receivingFinalizationSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps warnings only in confirmation and refuses unknown frozen keys", () => {
    const warning = {
      severity: "warning" as const,
      group: "documents" as const,
      line: null,
      field: "documents" as const,
      code: "required" as const,
      detail: null,
    };
    expect(
      contracts.receivingFinalizationSnapshotSchema.parse({
        ...snapshot,
        confirmation: { ...snapshot.confirmation, warnings: [warning] },
      }).confirmation.warnings,
    ).toEqual([warning]);
    for (const invalid of [
      { ...snapshot, warnings: [warning] },
      { ...snapshot, unknown: true },
      { ...snapshot, items: [{ ...at(snapshot.items, 0), exemptSupplier: false }] },
      {
        ...snapshot,
        confirmation: { ...snapshot.confirmation, warnings: [{ ...warning, severity: "error" }] },
      },
    ])
      expect(contracts.receivingFinalizationSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires documents for the FSMA profile but preserves generic-profile warnings", () => {
    expect(
      contracts.receivingFinalizationSnapshotSchema.safeParse({ ...snapshot, documents: [] })
        .success,
    ).toBe(false);
    const genericWarnings = [
      {
        severity: "warning" as const,
        group: "lines" as const,
        line: 1,
        field: "coverage" as const,
        code: "not_assessed" as const,
        detail: null,
      },
      {
        severity: "warning" as const,
        group: "documents" as const,
        line: null,
        field: "documents" as const,
        code: "required" as const,
        detail: null,
      },
    ];
    const generic = {
      ...snapshot,
      profileCode: "US_GENERIC_LOT_TRACEABILITY" as const,
      items: [
        {
          ...at(snapshot.items, 0),
          coverage: {
            coverageStatus: "unknown" as const,
            coverageRationale: null,
            ftlCategory: null,
            ftlSourceUrl: null,
            ftlSourceVersion: null,
            reviewedBy: null,
            reviewedAt: null,
          },
        },
      ],
      documents: [],
      confirmation: { ...snapshot.confirmation, warnings: genericWarnings },
    };
    expect(contracts.receivingFinalizationSnapshotSchema.parse(generic)).toEqual(generic);
    expect(
      contracts.receivingFinalizationSnapshotSchema.safeParse({
        ...generic,
        items: [{ ...at(generic.items, 0), coverage: at(snapshot.items, 0).coverage }],
      }).success,
    ).toBe(false);
  });

  it("preserves the exact existing draft record shape in the lifecycle union", () => {
    expect(contracts.receivingRecordSchema.parse(savedDraft)).toEqual(savedDraft);
    expect(contracts.receivingDraftRecordSchema.parse(savedDraft)).toEqual(savedDraft);
    expect(
      contracts.receivingRecordSchema.safeParse({
        ...savedDraft,
        finalizedAt: finalized.finalizedAt,
      }).success,
    ).toBe(false);
  });

  it("supports bounded mixed-status summaries and an optional strict status filter", () => {
    const draftSummary = {
      id: eventId,
      eventNumber: "REC-26-0001",
      status: "draft" as const,
      revision: 1 as const,
      draftVersion: 7,
      timeZone: "America/Chicago",
      createdBy: "creator-user",
      updatedBy: "creator-user",
      createdAt: "2026-09-07T09:00:00.000Z",
      updatedAt: "2026-09-07T09:00:00.000Z",
      dateReceived: "2026-09-07",
      locationId: receivingLocationId,
      previousSourceLocationId: sourceLocationId,
      lineCount: 1,
      documentCount: 1,
    };
    const finalizedSummary = { ...draftSummary, id: lotId, status: "finalized" as const };
    expect(contracts.listReceivingRecordsQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(contracts.listReceivingRecordsQuerySchema.parse({ status: "finalized" })).toEqual({
      status: "finalized",
      limit: 50,
      offset: 0,
    });
    expect(
      contracts.receivingRecordListSchema.parse({
        items: [draftSummary, finalizedSummary],
        limit: 2,
        offset: 0,
      }),
    ).toEqual({ items: [draftSummary, finalizedSummary], limit: 2, offset: 0 });
    for (const invalid of [
      { status: "all" },
      { status: ["draft", "finalized"] },
      { status: "draft", unknown: true },
    ])
      expect(contracts.listReceivingRecordsQuerySchema.safeParse(invalid).success).toBe(false);
    expect(
      contracts.receivingRecordListSchema.safeParse({
        items: [draftSummary, finalizedSummary],
        limit: 1,
        offset: 0,
      }).success,
    ).toBe(false);
  });
});
