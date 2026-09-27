import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  finalizeShippingSchema,
  shippingFinalizationSnapshotV1Schema,
  shippingHttpErrorSchema,
  shippingHttpRecordSchema,
} from "../src/index.js";

describe("Shipping finalization HTTP contract", () => {
  it("requires operation identity, saved version and exact readiness digest", () => {
    const input = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: "a".repeat(64),
    };
    expect(finalizeShippingSchema.parse(input)).toEqual(input);
    expect(
      finalizeShippingSchema.safeParse({ ...input, tlc: "client cannot set this" }).success,
    ).toBe(false);
    expect(
      finalizeShippingSchema.safeParse({ ...input, expectedInputDigest: "invalid" }).success,
    ).toBe(false);
  });

  it("bounds typed readiness conflicts and refuses client-crafted extra snapshot fields", () => {
    expect(
      shippingHttpErrorSchema.parse({
        code: "event_incomplete",
        issues: [
          {
            severity: "error",
            path: "documentIds",
            code: "required",
            line: null,
          },
        ],
      }),
    ).toMatchObject({ code: "event_incomplete" });
    expect(
      shippingHttpErrorSchema.safeParse({ code: "event_incomplete", issues: [], secret: "x" })
        .success,
    ).toBe(false);
    expect(
      shippingFinalizationSnapshotV1Schema.safeParse({ snapshotVersion: 1, eventId: randomUUID() })
        .success,
    ).toBe(false);
    expect(shippingHttpRecordSchema.safeParse({ status: "finalized", snapshot: {} }).success).toBe(
      false,
    );
  });

  it("pins typed location, source and product KDEs without flattening commas or nulls", () => {
    const shipFromId = randomUUID();
    const recipientId = randomUUID();
    const partyId = randomUUID();
    const productId = randomUUID();
    const shipFrom = {
      schemaVersion: 1,
      locationId: shipFromId,
      partyId,
      businessName: "Supplier, Inc.",
      phoneNumber: "+1 555 010 0100 ext 42",
      address: { kind: "street", streetAddress: "1 Main Street, Suite 4" },
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      countryDisplay: "United States",
    };
    const recipient = {
      ...shipFrom,
      locationId: recipientId,
      businessName: "Buyer, LLC",
      address: { kind: "coordinates", latitude: "41.881832", longitude: "-87.627761" },
    };
    const snapshot = {
      snapshotVersion: 1,
      eventId: randomUUID(),
      eventNumber: "SHP-26-0001",
      revision: 1,
      eventDate: "2026-09-27",
      timeZone: "America/Chicago",
      shipFrom,
      recipient,
      carrierReference: null,
      notes: null,
      items: [
        {
          lineNo: 1,
          lotId: randomUUID(),
          quantity: "12",
          unitOfMeasure: "case",
          tlc: "TLC-1",
          source: {
            kind: "reference",
            referenceKind: "web_url",
            referenceValue: "https://example.test/tlc/source",
            resolvedLocation: shipFrom,
          },
          product: {
            id: productId,
            description: {
              snapshotVersion: 1,
              sourceProductId: productId,
              productName: "Apples, sliced",
              brandName: null,
              commodity: "Fruit, fresh-cut",
              variety: null,
              packagingSize: { value: "12.000", uom: "case" },
              packagingStyle: "Case, sealed",
              gtin: null,
            },
            coverage: {
              coverageStatus: "covered",
              coverageRationale: "Reviewed",
              ftlCategory: "Fresh-cut fruits",
              ftlSourceUrl:
                "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
              ftlSourceVersion: "Synthetic 2026",
              reviewedBy: "qa",
              reviewedAt: "2026-09-27T00:00:00.000Z",
            },
          },
        },
      ],
      documents: [{ id: randomUUID(), type: "bol", number: "BOL-1", issuer: null }],
      finalizedBy: "qa",
      finalizedAt: "2026-09-27T00:00:00.000Z",
    };
    expect(shippingFinalizationSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(
      shippingFinalizationSnapshotV1Schema.safeParse({
        ...snapshot,
        recipient: { id: recipientId, description: "Buyer, LLC, 41.881832, -87.627761" },
      }).success,
    ).toBe(false);
  });
});
