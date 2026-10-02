import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import type {
  ExportInputV1,
  ReceivingFinalizationSnapshotV3,
  TransformationFinalizationSnapshotV1,
  ShippingFinalizationSnapshotV1,
} from "@markiro/platform-contracts";
import { buildUsExportWorkbook, traceExportRegistryHash } from "@markiro/domain";
import { renderUsExportCore } from "../src/modules/traceability/export/adapter.js";

const eventId = "00000000-0000-4000-8000-000000000001";
const registryHash = traceExportRegistryHash();
const sourceRecord = `receiving:${eventId}:1:item:1`;
const id = (tail: number) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const location = (tail: number, businessName: string) => ({
  schemaVersion: 1 as const,
  locationId: id(tail),
  partyId: id(7),
  businessName,
  phoneNumber: "+1 509 555 0100",
  address: { kind: "street" as const, streetAddress: "100 Test Way" },
  city: "Yakima",
  stateOrRegion: "WA",
  zipOrPostalCode: "98901",
  countryCode: "US",
  countryDisplay: "United States",
});
const snapshotV3: ReceivingFinalizationSnapshotV3 = {
  snapshotVersion: 3,
  dateReceived: "2026-09-07",
  locationId: id(5),
  previousSourceLocationId: id(6),
  receivedAtNote: "Door 4",
  notes: "Captured receipt",
  profileCode: "US_FSMA204_PROCESSOR",
  baselineVersion: "US-REG-2026-09-03",
  locationDescription: location(5, "Synthetic receiver"),
  previousSourceDescription: location(6, "Synthetic supplier"),
  items: [
    {
      lineNo: 1,
      productId: id(3),
      lotId: id(4),
      lotLinkMode: "create_on_finalize",
      lotBinding: { kind: "created" },
      receiptBasis: { kind: "ordinary" },
      tlc: "=Case/Ä-001",
      source: {
        kind: "reference",
        referenceKind: "web_url",
        referenceValue: "https://supplier.example.test/Case/A",
        resolvedLocationId: id(6),
      },
      quantity: "500.000",
      unitOfMeasure: "lb",
      supplierLotReference: "Supplier lot 00001",
      notes: "Captured line",
      productDescription: {
        snapshotVersion: 1,
        sourceProductId: id(3),
        productName: "Apple slices",
        brandName: "Test Orchard",
        commodity: "Apple",
        variety: "Gala",
        packagingSize: { value: "25.000", uom: "lb" },
        packagingStyle: "Case",
        gtin: "00000000000000",
      },
      coverage: {
        coverageStatus: "covered",
        coverageRationale: "Synthetic review",
        ftlCategory: "Fresh-cut fruits",
        ftlSourceUrl: "https://www.fda.gov/example",
        ftlSourceVersion: "2026-09-03",
        reviewedBy: "qa-user",
        reviewedAt: "2026-09-07T10:00:00.000Z",
      },
      sourceDescription: location(6, "Synthetic supplier"),
    },
  ],
  documents: [
    {
      document: {
        snapshotVersion: 1,
        documentId: id(8),
        type: "bol",
        typeOtherLabel: null,
        number: "=BOL-0001",
        partyId: id(7),
        issuedOn: "2026-09-07",
        notes: null,
      },
      issuer: { id: id(7), name: "Synthetic supplier", legalName: "Supplier Farms LLC" },
    },
  ],
  confirmation: {
    ruleVersion: "receiving-readiness-v4",
    inputDigest: "a".repeat(64),
    warnings: [],
    reviewedExemptLines: [],
  },
};

function fixture(): ExportInputV1 {
  return {
    schemaVersion: 1,
    mode: "export_ready_candidate",
    tenantId: "synthetic",
    events: [
      {
        type: "receiving",
        eventId,
        revision: 1,
        lifecycle: "current_finalized",
        timeZone: "America/Los_Angeles",
        payload: { kind: "frozen", snapshot: snapshotV3 },
      },
    ],
    findings: [],
    metadata: {
      mode: "export_ready_candidate",
      profile: "US_FSMA204_PROCESSOR",
      scopeLabel: "Captured receipts",
      timeZone: "America/Chicago",
      generatedAt: "2026-10-02T10:00:00.000Z",
      baselineId: "US-REG-2026-09-03",
      registryId: "fda_sortable_xlsx",
      registryVersion: 1,
      registryHash,
      build: { apiVersion: "0.1.0", gitSha: "a".repeat(40), dirty: true },
    },
  };
}

function threeCteFixture(receivingLines = 1): ExportInputV1 {
  const base = fixture();
  const receivingRecord = base.events[0];
  if (!receivingRecord || receivingRecord.type !== "receiving")
    throw new Error("Missing Receiving event");
  const first = snapshotV3.items[0];
  if (!first) throw new Error("Missing Receiving line");
  const receipt: ReceivingFinalizationSnapshotV3 = {
    ...snapshotV3,
    items: Array.from({ length: receivingLines }, (_, index) => ({
      ...first,
      lineNo: index + 1,
      lotId: id(100 + index),
      tlc: `R-${index + 1}`,
      quantity: "5",
    })),
  };
  const covered = {
    coverageStatus: "covered" as const,
    coverageRationale: "Synthetic reviewed FTL",
    ftlCategory: "Fresh-cut fruits",
    ftlSourceUrl: "https://www.fda.gov/example",
    ftlSourceVersion: "2026-09-03",
    reviewedBy: "qa-user",
    reviewedAt: "2026-09-07T10:00:00.000Z",
  };
  const product = { id: id(3), description: "Frozen apples | opaque", coverage: covered };
  const processor = { id: id(20), description: "Saved processor" };
  const transformation: TransformationFinalizationSnapshotV1 = {
    snapshotVersion: 1,
    eventId: id(2),
    eventNumber: "TRN-26-0001",
    revision: 1,
    eventDate: "2026-09-08",
    timeZone: "America/Chicago",
    processor,
    reason: "commingling_and_repacking",
    reasonNote: null,
    notes: null,
    inputs: [
      {
        kind: "ftl_lot",
        lineNo: 1,
        lotId: id(100),
        product,
        tlc: "R-1",
        source: { kind: "location", id: id(6), description: "Saved grower" },
        quantity: "5",
        unitOfMeasure: "lb",
      },
      {
        kind: "ftl_lot",
        lineNo: 2,
        lotId: id(101),
        product,
        tlc: "R-2",
        source: { kind: "location", id: id(6), description: "Saved grower" },
        quantity: "5",
        unitOfMeasure: "lb",
      },
    ],
    outputs: [
      {
        lineNo: 1,
        lotId: id(201),
        product,
        tlc: "T-1",
        source: { kind: "location", ...processor },
        quantity: "4",
        unitOfMeasure: "lb",
      },
      {
        lineNo: 2,
        lotId: id(202),
        product,
        tlc: "T-2",
        source: { kind: "location", ...processor },
        quantity: "6",
        unitOfMeasure: "lb",
      },
    ],
    documents: [{ id: id(8), type: "bol", number: "BOL-1" }],
    finalizedBy: "qa",
    finalizedAt: "2026-09-08T10:00:00.000Z",
  };
  const shipping: ShippingFinalizationSnapshotV1 = {
    snapshotVersion: 1,
    eventId: id(3),
    eventNumber: "SHP-26-0001",
    revision: 1,
    eventDate: "2026-09-09",
    timeZone: "America/Chicago",
    shipFrom: location(20, "Saved processor"),
    recipient: location(21, "Saved buyer"),
    carrierReference: null,
    notes: null,
    items: [
      {
        lineNo: 1,
        lotId: id(201),
        quantity: "4",
        unitOfMeasure: "lb",
        tlc: "T-1",
        source: { kind: "location", location: location(20, "Saved processor") },
        product: { id: id(3), description: first.productDescription, coverage: covered },
      },
    ],
    documents: [
      {
        id: id(8),
        type: "bol",
        number: "BOL-1",
        issuer: { id: id(7), name: "Synthetic supplier", legalName: "Supplier Farms LLC" },
      },
    ],
    finalizedBy: "qa",
    finalizedAt: "2026-09-09T10:00:00.000Z",
  };
  return {
    ...base,
    events: [
      { ...receivingRecord, payload: { kind: "frozen", snapshot: receipt } },
      {
        type: "transformation",
        eventId: id(2),
        revision: 1,
        lifecycle: "current_finalized",
        timeZone: "America/Chicago",
        payload: { kind: "frozen", snapshot: transformation },
      },
      {
        type: "shipping",
        eventId: id(3),
        revision: 1,
        lifecycle: "current_finalized",
        timeZone: "America/Chicago",
        payload: { kind: "frozen", snapshot: shipping },
      },
    ],
  };
}

describe("US export core adapter", () => {
  it("renders a clean pinned record with exact source identity and deterministic bytes", async () => {
    const input = fixture();
    const first = await renderUsExportCore(input);
    const second = await renderUsExportCore(input);
    expect(first.workbook).toBeInstanceOf(Uint8Array);
    expect(first.workbook).toEqual(second.workbook);
    expect(first.workbookSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.workbookSha256).toBe(second.workbookSha256);
    expect(first.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.inputDigest).toBe(second.inputDigest);
    expect(first.registryVersion).toBe(1);
    expect(first.registryHash).toBe(registryHash);
    expect(first.rowCounts).toEqual({
      metadata: 16,
      definitions: 63,
      receiving: 1,
      transformation: 0,
      shipping: 0,
      validation: 2,
    });
    expect(first.findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(first.failure).toBeNull();
    if (!first.workbook) throw new Error("Expected XLSX bytes");
    const parts = unzipSync(first.workbook);
    const shared = new TextDecoder().decode(parts["xl/sharedStrings.xml"]);
    expect(shared).toContain(sourceRecord);
  });

  it("keeps an incomplete pinned record and its source-linked findings in the workbook", async () => {
    const input = fixture();
    const record = input.events[0];
    if (!record) throw new Error("Missing Receiving fixture");
    const incomplete: ExportInputV1 = {
      ...input,
      mode: "available_records_incomplete",
      metadata: { ...input.metadata, mode: "available_records_incomplete" },
      events: [{ ...record, lifecycle: "historical_finalized" }],
    };
    const result = await renderUsExportCore(incomplete);
    expect(result.workbook).toBeInstanceOf(Uint8Array);
    expect(result.workbookSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rowCounts).toMatchObject({ receiving: 1 });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_RECORD_NOT_CURRENT_FINALIZED",
        sourceRecord: `receiving:${eventId}:1`,
        severity: "error",
      }),
    );
    expect(result.failure).toBeNull();
  });

  it("rejects malformed input and a changed registry pin before rendering", async () => {
    const input = fixture();
    await expect(
      renderUsExportCore({ ...input, extra: true } as ExportInputV1),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      renderUsExportCore({
        ...input,
        metadata: { ...input.metadata, registryHash: "b".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "REGISTRY_MISMATCH" });
    await expect(
      renderUsExportCore({
        ...input,
        metadata: { ...input.metadata, registryVersion: 2 },
      } as unknown as ExportInputV1),
    ).rejects.toMatchObject({ code: "REGISTRY_MISMATCH" });
  });

  it("returns no bytes and a source-linked artifact failure for an unsafe cell", async () => {
    const input = fixture();
    const unsafeInput = {
      ...input,
      metadata: { ...input.metadata, scopeLabel: "x".repeat(32768) },
    };
    const result = await renderUsExportCore(unsafeInput);
    expect(result.workbook).toBeNull();
    expect(result.workbookSha256).toBeNull();
    expect(result.failure).toEqual({
      code: "CELL_LIMIT_EXCEEDED",
      sourceRecord: "metadata",
      fieldKey: "scope_label",
    });
    expect(result.rowCounts).toEqual({
      metadata: 0,
      definitions: 0,
      receiving: 0,
      transformation: 0,
      shipping: 0,
      validation: 0,
    });
    expect(result.findings).toEqual(buildUsExportWorkbook(unsafeInput).findings);
    expect(result.findings.some((finding) => finding.code === "CELL_LIMIT_EXCEEDED")).toBe(false);
  });

  it("keeps exactly two input and two output quantity rows for a 2-to-2 transformation", async () => {
    const input = threeCteFixture(2);
    const result = await renderUsExportCore(input);
    expect(result.failure).toBeNull();
    expect(result.rowCounts).toMatchObject({ receiving: 2, transformation: 4, shipping: 1 });
    if (!result.workbook) throw new Error("Expected XLSX bytes");
    const shared = new TextDecoder().decode(unzipSync(result.workbook)["xl/sharedStrings.xml"]);
    for (const identity of [
      `transformation:${id(2)}:1:input:1`,
      `transformation:${id(2)}:1:input:2`,
      `transformation:${id(2)}:1:output:1`,
      `transformation:${id(2)}:1:output:2`,
    ])
      expect(shared).toContain(identity);
  });

  it("keeps pinned revision bytes stable after a later captured amendment and event reordering", async () => {
    const frozen = threeCteFixture(2);
    const first = await renderUsExportCore(frozen);
    const reordered = { ...frozen, events: [...frozen.events].reverse() };
    const second = await renderUsExportCore(reordered);
    expect(second.inputDigest).toBe(first.inputDigest);
    expect(second.workbookSha256).toBe(first.workbookSha256);
    expect(second.workbook).toEqual(first.workbook);
    const originalReceipt = frozen.events.find((event) => event.type === "receiving");
    if (
      !originalReceipt ||
      originalReceipt.payload.kind !== "frozen" ||
      originalReceipt.payload.snapshot.snapshotVersion !== 3
    )
      throw new Error("Missing Receiving fixture");
    const capturedReceipt: ReceivingFinalizationSnapshotV3 = originalReceipt.payload.snapshot;
    const laterAmendment: ExportInputV1 = {
      ...frozen,
      events: frozen.events.map((event) =>
        event.type === "receiving"
          ? {
              ...originalReceipt,
              revision: 2,
              payload: {
                kind: "frozen" as const,
                snapshot: {
                  ...capturedReceipt,
                  items: capturedReceipt.items.map((line) => ({ ...line, tlc: "LATER-TLC" })),
                },
              },
            }
          : event,
      ),
    };
    const later = await renderUsExportCore(laterAmendment);
    expect(later.inputDigest).not.toBe(first.inputDigest);
    expect(later.workbookSha256).not.toBe(first.workbookSha256);
    expect((await renderUsExportCore(frozen)).workbookSha256).toBe(first.workbookSha256);
  });

  it("translates an XLSX-only render refusal without claiming an incomplete workbook", async () => {
    const input = fixture();
    const event = input.events[0];
    if (!event || event.type !== "receiving" || event.payload.kind !== "frozen")
      throw new Error("Missing Receiving fixture");
    const earlyInput: ExportInputV1 = {
      ...input,
      events: [
        {
          ...event,
          payload: {
            kind: "frozen",
            snapshot: { ...event.payload.snapshot, dateReceived: "1900-02-01" },
          },
        },
      ],
    };
    const result = await renderUsExportCore(earlyInput);
    expect(result.workbook).toBeNull();
    expect(result.workbookSha256).toBeNull();
    expect(result.failure).toEqual({
      code: "XLSX_RENDER_FAILED",
      sourceRecord,
      fieldKey: "date_received",
    });
    expect(result.findings).toEqual(buildUsExportWorkbook(earlyInput).findings);
    expect(result.rowCounts.receiving).toBe(1);
  });

  it("renders the controlled 100-line three-CTE synthetic fixture within 60 seconds locally", async () => {
    const input = threeCteFixture(100);
    const started = performance.now();
    const result = await renderUsExportCore(input);
    const elapsedMs = performance.now() - started;
    expect(result.failure).toBeNull();
    expect(result.workbook).toBeInstanceOf(Uint8Array);
    expect(result.rowCounts).toMatchObject({ receiving: 100, transformation: 4, shipping: 1 });
    expect(elapsedMs).toBeLessThan(60_000);
  });
});
