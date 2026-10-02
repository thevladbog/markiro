import { describe, expect, it } from "vitest";
import type { ExportInputV1, ExportSourceRecord } from "../../platform-contracts/dist/index.js";
import {
  at,
  snapshotV1,
  snapshotV2,
  snapshotV3,
} from "../../platform-contracts/test/support/us-receiving-lifecycle-fixture.js";
import { buildUsExportRows, compareExportRowIdentity } from "../src/traceability/export/rows.js";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const originalLine = at(snapshotV1.items, 0);
const processor = { id: id(50), description: "  Processor | phone and address unsplit  " };
const product = {
  id: originalLine.productId,
  description: "  Apples | 25 lb case  ",
  coverage: originalLine.coverage,
};
const documents = [
  { id: id(62), type: "bol", number: "  0002\ncontinued  " },
  { id: id(61), type: "invoice", number: "0001" },
  { id: id(63), type: "other", number: 'a,"b"' },
];
const receiving: ExportSourceRecord = {
  type: "receiving",
  eventId: id(1),
  revision: 1,
  lifecycle: "current_finalized",
  timeZone: "America/Los_Angeles",
  payload: {
    kind: "frozen",
    snapshot: {
      ...snapshotV3,
      items: [
        { ...at(snapshotV3.items, 0), quantity: "40" },
        {
          ...at(snapshotV3.items, 0),
          lineNo: 2,
          lotId: id(12),
          quantity: "60",
          source: { kind: "location", locationId: id(52) },
          sourceDescription: {
            ...originalLine.sourceDescription,
            locationId: id(52),
            businessName: "Second grower",
          },
        },
      ],
    },
  },
};
const transformation: ExportSourceRecord = {
  type: "transformation",
  eventId: id(2),
  revision: 1,
  lifecycle: "current_finalized",
  timeZone: "America/Chicago",
  payload: {
    kind: "frozen",
    snapshot: {
      snapshotVersion: 1,
      eventId: id(2),
      eventNumber: "TRN-26-0001",
      revision: 1,
      eventDate: "2026-09-08",
      timeZone: "America/Chicago",
      processor,
      reason: "repacking",
      reasonNote: null,
      notes: null,
      inputs: [
        {
          kind: "ftl_lot",
          lineNo: 1,
          lotId: originalLine.lotId,
          product,
          tlc: "SAME-TLC",
          source: { kind: "location", id: id(51), description: "Grower one" },
          quantity: "40",
          unitOfMeasure: "lb",
        },
        {
          kind: "ftl_lot",
          lineNo: 2,
          lotId: id(12),
          product,
          tlc: "SAME-TLC",
          source: {
            kind: "reference",
            id: id(52),
            description: "Grower two",
            referenceKind: "web_url",
            referenceValue: "https://example.test/Two",
          },
          quantity: "60",
          unitOfMeasure: "lb",
        },
      ],
      outputs: [
        {
          lineNo: 1,
          lotId: id(13),
          product,
          tlc: "OUT-1",
          source: { kind: "location", ...processor },
          quantity: "25",
          unitOfMeasure: "lb",
        },
        {
          lineNo: 2,
          lotId: id(14),
          product,
          tlc: "OUT-2",
          source: { kind: "location", ...processor },
          quantity: "75",
          unitOfMeasure: "lb",
        },
      ],
      documents,
      finalizedBy: "qa",
      finalizedAt: "2026-09-08T10:00:00.000Z",
    },
  },
};
const shipping: ExportSourceRecord = {
  type: "shipping",
  eventId: id(3),
  revision: 1,
  lifecycle: "current_finalized",
  timeZone: "America/Chicago",
  payload: {
    kind: "frozen",
    snapshot: {
      snapshotVersion: 1,
      eventId: id(3),
      eventNumber: "SHP-26-0001",
      revision: 1,
      eventDate: "2026-09-09",
      timeZone: "America/Chicago",
      shipFrom: snapshotV1.locationDescription,
      recipient: {
        ...snapshotV1.previousSourceDescription,
        businessName: "Frozen recipient",
        address: { kind: "coordinates", latitude: "45.001000", longitude: "-120.020000" },
      },
      carrierReference: null,
      notes: null,
      items: [
        {
          lineNo: 1,
          lotId: id(13),
          quantity: "2.000",
          unitOfMeasure: "lb",
          tlc: "OUT-1",
          source: {
            kind: "reference",
            referenceKind: "web_url",
            referenceValue: "https://example.test/source",
            resolvedLocation: snapshotV1.locationDescription,
          },
          product: {
            id: originalLine.productId,
            description: originalLine.productDescription,
            coverage: originalLine.coverage,
          },
        },
      ],
      documents: documents.map((document) => ({ ...document, issuer: null })),
      finalizedBy: "qa",
      finalizedAt: "2026-09-09T10:00:00.000Z",
    },
  },
};
function input(
  events: ExportSourceRecord[] = [receiving, transformation, shipping],
): ExportInputV1 {
  return {
    schemaVersion: 1,
    mode: "available_records_incomplete",
    tenantId: "synthetic",
    events,
    findings: [],
    metadata: {
      mode: "available_records_incomplete",
      profile: "US_FSMA204_PROCESSOR",
      scopeLabel: "Fixture",
      timeZone: "America/Chicago",
      generatedAt: "2026-10-02T10:00:00.000Z",
      baselineId: "US-REG-2026-09-03",
      registryId: "fda_sortable_xlsx",
      registryVersion: 1,
      registryHash: "b".repeat(64),
      build: { apiVersion: "0.1.0", gitSha: "a".repeat(40), dirty: true },
    },
  };
}

describe("US saved source rows", () => {
  it("uses captured pin identity and timezone even when frozen payload carries its own header", () => {
    if (transformation.payload.kind !== "frozen" || shipping.payload.kind !== "frozen")
      throw new Error("Expected frozen fixtures");
    const eventId = "abcdefab-0000-4000-8000-000000000001";
    const records: ExportSourceRecord[] = [
      {
        ...transformation,
        eventId,
        timeZone: "America/New_York",
        payload: {
          kind: "frozen",
          snapshot: {
            ...transformation.payload.snapshot,
            eventId: eventId.toUpperCase(),
            timeZone: "America/Chicago",
          },
        },
      },
      { ...shipping, timeZone: "America/New_York" },
    ];
    const rows = buildUsExportRows(input(records));
    expect(rows[0]?.eventId).toBe(eventId);
    expect(rows[0]?.values.event_id).toBe(eventId);
    expect(rows[0]?.sourceRecord).toBe(`transformation:${eventId}:1:input:1`);
    expect(rows.map((row) => row.values.event_timezone)).toEqual([
      "America/New_York",
      "America/New_York",
      "America/New_York",
      "America/New_York",
      "America/New_York",
    ]);
  });

  // Catch Cartesian allocations, TLC collapse and quantities copied to opposite roles.
  it("projects each branching source line exactly once with its own identity and quantity", () => {
    const rows = buildUsExportRows(input());
    expect(
      rows.map((row) => [
        row.sheet,
        row.eventId,
        row.lineRole,
        row.lineNo,
        row.lotId,
        row.values.quantity,
      ]),
    ).toEqual([
      ["receiving", id(1), "item", 1, originalLine.lotId, "40"],
      ["receiving", id(1), "item", 2, id(12), "60"],
      ["transformation", id(2), "input", 1, originalLine.lotId, "40"],
      ["transformation", id(2), "input", 2, id(12), "60"],
      ["transformation", id(2), "output", 1, id(13), "25"],
      ["transformation", id(2), "output", 2, id(14), "75"],
      ["shipping", id(3), "item", 1, id(13), "2.000"],
    ]);
    expect(rows[0]?.values.tlc).toBe("=Case/Ä-001");
    expect(rows[1]?.values.tlc).toBe("=Case/Ä-001");
    expect(rows[0]?.values.tlc_source_business_name).toBe("Synthetic supplier");
    expect(rows[1]?.values.tlc_source_business_name).toBe("Second grower");
    expect(rows[0]?.sourceRecord).toBe(`receiving:${id(1)}:1:item:1`);
  });

  it.each([snapshotV1, snapshotV2, snapshotV3])(
    "retains exact Receiving snapshot v$snapshotVersion fields",
    (snapshot) => {
      const [row] = buildUsExportRows(
        input([{ ...receiving, payload: { kind: "frozen", snapshot } }]),
      );
      expect(row?.values).toMatchObject({
        product_name: "Apple slices",
        product_brand_name: "Test Orchard",
        product_commodity: "Apple",
        product_variety: "Gala",
        product_packaging_size_value: "25.000",
        product_packaging_size_uom: "lb",
        product_packaging_style: "Case",
        product_gtin: "00000000000000",
        previous_source_business_name: "Synthetic supplier",
        previous_source_phone_number: "+1 509 555 0100",
        receiving_location_street_address_or_coordinates: "100 Test Way",
        receiving_location_city: "Yakima",
        receiving_location_state_or_region: "WA",
        receiving_location_zip_or_postal_code: "98901",
        receiving_location_country_code: "US",
        receiving_location_country_display: "United States",
        date_received: "2026-09-07",
        quantity: "500.000",
        event_timezone: "America/Los_Angeles",
        tlc_source_reference_kind: "web_url",
        tlc_source_reference_value: "https://supplier.example.test/Case/A",
        reference_document_numbers: '["  =BOL-0001  "]',
        snapshot_version: String(snapshot.snapshotVersion),
      });
    },
  );

  it("keeps opaque Transformation descriptions without inventing split KDEs", () => {
    const rows = buildUsExportRows(input([transformation]));
    expect(rows.map((row) => row.values.product_description_original)).toEqual(
      Array(4).fill("  Apples | 25 lb case  "),
    );
    expect(rows.map((row) => row.values.tlc_source_description_original)).toEqual([
      "Grower one",
      "Grower two",
      "  Processor | phone and address unsplit  ",
      "  Processor | phone and address unsplit  ",
    ]);
    for (const row of rows)
      expect(row.values).toMatchObject({
        product_name: null,
        product_packaging_size_value: null,
        transformation_location_business_name: null,
        tlc_source_business_name: null,
        transformation_location_description_original: "  Processor | phone and address unsplit  ",
      });
    expect(rows[1]?.values.tlc_source_reference_value).toBe("https://example.test/Two");
  });

  it("retains a non-FTL input as its own row without fabricating a lot or TLC", () => {
    if (transformation.payload.kind !== "frozen") throw new Error("Expected frozen fixture");
    const snapshot = transformation.payload.snapshot;
    const rows = buildUsExportRows(
      input([
        {
          ...transformation,
          payload: {
            kind: "frozen",
            snapshot: {
              ...snapshot,
              inputs: [
                {
                  kind: "non_ftl",
                  lineNo: 1,
                  product: {
                    ...product,
                    coverage: {
                      ...product.coverage,
                      coverageStatus: "not_covered",
                      ftlCategory: null,
                      ftlSourceUrl: null,
                      ftlSourceVersion: null,
                    },
                  },
                  source: { kind: "location", id: id(51), description: "Salt supplier" },
                  reference: "  Salt batch 0001  ",
                  quantity: "1.500",
                  unitOfMeasure: "lb",
                },
              ],
              outputs: [at(snapshot.outputs, 0)],
            },
          },
        },
      ]),
    );
    expect(
      rows.map((row) => [
        row.lineRole,
        row.lotId,
        row.values.tlc,
        row.values.quantity,
        row.values.non_ftl_reference,
      ]),
    ).toEqual([
      ["input", null, null, "1.500", "  Salt batch 0001  "],
      ["output", id(13), "OUT-1", "25", null],
    ]);
  });

  it("retains all parallel document values without multiplying source rows", () => {
    const rows = buildUsExportRows(input([transformation, shipping]));
    expect(rows).toHaveLength(5);
    for (const row of rows)
      expect(row.values).toMatchObject({
        reference_document_ids: JSON.stringify([id(62), id(61), id(63)]),
        reference_document_types: '["bol","invoice","other"]',
        reference_document_numbers: '["  0002\\ncontinued  ","0001","a,\\"b\\""]',
      });
    expect(rows[4]?.values).toMatchObject({
      recipient_business_name: "Frozen recipient",
      recipient_address_kind: "coordinates",
      recipient_street_address_or_coordinates: "45.001000, -120.020000",
      ship_from_business_name: "Synthetic receiver",
      tlc_source_business_name: "Synthetic receiver",
    });
  });

  it("keeps pinned history and source order deterministic when selections are shuffled", () => {
    const historical: ExportSourceRecord = {
      ...receiving,
      revision: 2,
      lifecycle: "historical_finalized",
    };
    const first = buildUsExportRows(input([receiving, historical, shipping, transformation]));
    const reversed = buildUsExportRows(input([transformation, shipping, historical, receiving]));
    expect(reversed).toEqual(first);
    expect(
      first.filter((row) => row.sheet === "receiving").map((row) => [row.lineNo, row.revision]),
    ).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ]);
    expect([...first].reverse().sort(compareExportRowIdentity)).toEqual(first);
  });

  it("never substitutes later mutable catalog descriptions for captured values", () => {
    const captured = structuredClone(input());
    const catalog = {
      product: { ...originalLine.productDescription },
      location: { ...snapshotV1.locationDescription },
    };
    const before = buildUsExportRows(captured);
    catalog.product.productName = "Renamed later";
    catalog.location.businessName = "Renamed later";
    expect(buildUsExportRows(captured)).toEqual(before);
    expect(before[0]?.values.product_name).toBe("Apple slices");
    expect(before[0]?.values.receiving_location_business_name).toBe("Synthetic receiver");
    expect(captured).toEqual(input());
  });

  it("preserves incomplete draft values and lifecycle without hydrating missing descriptions", () => {
    const events: ExportSourceRecord[] = [
      {
        ...receiving,
        revision: 2,
        lifecycle: "draft",
        payload: {
          kind: "saved_draft",
          draft: {
            dateReceived: null,
            locationId: id(50),
            previousSourceLocationId: id(51),
            receivedAtNote: null,
            notes: null,
            documentIds: [id(62), id(61)],
            items: [
              {
                previousLineNo: 4,
                productId: originalLine.productId,
                lotLinkMode: "link_existing",
                lotId: originalLine.lotId,
                tlc: "SAVED",
                source: {
                  kind: "reference",
                  referenceKind: "web_url",
                  referenceValue: "https://example.test/saved",
                  resolvedLocationId: id(51),
                },
                exemptSupplier: false,
                exemptReason: null,
                supplierLotReference: null,
                quantity: "0.500",
                unitOfMeasure: null,
                notes: null,
              },
            ],
          },
        },
      },
      {
        ...transformation,
        lifecycle: "draft",
        payload: {
          kind: "saved_draft",
          draft: {
            eventDate: "2026-09-08",
            processorLocationId: id(50),
            reason: null,
            reasonNote: null,
            notes: null,
            documentIds: [],
            inputs: [
              { kind: "ftl_lot", lotId: id(12), quantity: null, unitOfMeasure: null },
              {
                kind: "non_ftl",
                productId: originalLine.productId,
                sourceLocationId: id(51),
                reference: "N",
                quantity: "1",
                unitOfMeasure: "lb",
              },
            ],
            outputs: [
              { productId: originalLine.productId, tlc: "NEW", quantity: "2", unitOfMeasure: "lb" },
            ],
          },
        },
      },
      {
        ...shipping,
        lifecycle: "void",
        payload: {
          kind: "saved_draft",
          draft: {
            eventDate: "2026-09-09",
            shipFromLocationId: id(50),
            recipientLocationId: id(51),
            carrierReference: null,
            notes: null,
            documentIds: [],
            items: [{ lotId: id(13), quantity: null, unitOfMeasure: null }],
          },
        },
      },
    ];
    const rows = buildUsExportRows(input(events));
    expect(rows).toHaveLength(5);
    expect(rows[0]?.values).toMatchObject({
      event_revision: "2",
      line_no: "1",
      lot_id: originalLine.lotId,
      product_id: originalLine.productId,
      product_name: null,
      quantity: "0.500",
      unit_of_measure: null,
      previous_source_business_name: null,
      date_received: null,
      event_lifecycle: "draft",
      event_timezone: "America/Los_Angeles",
      snapshot_version: null,
      tlc_source_reference_value: "https://example.test/saved",
      reference_document_types: "[null,null]",
      reference_document_numbers: "[null,null]",
    });
    expect(rows.map((row) => row.values.product_name)).toEqual([null, null, null, null, null]);
    expect(rows[1]?.values).toMatchObject({
      lot_id: id(12),
      product_id: null,
      tlc: null,
      quantity: null,
    });
    expect(rows[2]?.values).toMatchObject({ lot_id: null, non_ftl_reference: "N", quantity: "1" });
    expect(rows[3]?.values).toMatchObject({
      lot_id: null,
      tlc: "NEW",
      product_id: originalLine.productId,
    });
    expect(rows[4]?.values.event_lifecycle).toBe("void");
  });
});
