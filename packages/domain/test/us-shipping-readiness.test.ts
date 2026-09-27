import { describe, expect, it } from "vitest";
import { validateShippingReadiness, type ShippingReadinessInput } from "../src/index.js";

const reviewedCoverage = {
  coverageStatus: "covered",
  coverageRationale: "Reviewed FTL",
  ftlCategory: "food",
  ftlSourceUrl:
    "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
  ftlSourceVersion: "2026",
  reviewedBy: "qa",
  reviewedAt: "2026-09-25T12:00:00Z",
} as const;

const ready: ShippingReadinessInput = {
  profileCode: "US_FSMA204_PROCESSOR",
  draft: {
    eventDate: "2026-09-27",
    timeZone: "America/New_York",
    shipFromLocationId: "processor",
    recipientLocationId: "recipient",
    documentIds: ["bill"],
    items: [{ lotId: "lot-1", quantity: "25", unitOfMeasure: "case" }],
  },
  locations: [
    { id: "processor", roles: ["processor"], archived: false, descriptionReady: true },
    { id: "recipient", roles: ["recipient"], archived: false, descriptionReady: true },
  ],
  documents: [{ id: "bill", archived: false, type: "bill_of_lading", number: "BOL-1" }],
  products: [
    { id: "product", archived: false, descriptionReady: true, coverage: reviewedCoverage },
  ],
  lots: [
    {
      id: "lot-1",
      productId: "product",
      tlc: "TLC-1",
      sourceResolved: true,
      status: "active",
      balance: {
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "25",
        remaining: "75",
      },
    },
  ],
};

describe("Shipping readiness", () => {
  it("accepts a complete partial shipment", () => {
    expect(validateShippingReadiness(ready)).toEqual([]);
  });

  it("accepts a candidate exactly equal to the remaining balance", () => {
    expect(
      validateShippingReadiness({
        ...ready,
        draft: {
          ...ready.draft,
          items: [{ lotId: "lot-1", quantity: "75", unitOfMeasure: "case" }],
        },
      }),
    ).toEqual([]);
  });

  it("blocks over-shipment and a zero pre-shipment balance at line paths", () => {
    expect(
      validateShippingReadiness({
        ...ready,
        draft: {
          ...ready.draft,
          items: [{ lotId: "lot-1", quantity: "75.001", unitOfMeasure: "case" }],
        },
      }),
    ).toContainEqual({ code: "over_shipment", path: "items[0].quantity", line: 1 });
    expect(
      validateShippingReadiness({
        ...ready,
        lots: [
          {
            ...ready.lots[0]!,
            balance: {
              state: "known",
              unitOfMeasure: "case",
              supply: "100",
              used: "100",
              remaining: "0",
            },
          },
        ],
      }),
    ).toContainEqual({ code: "balance_exhausted", path: "items[0].quantity", line: 1 });
    expect(
      validateShippingReadiness({
        ...ready,
        lots: [
          {
            ...ready.lots[0]!,
            balance: {
              state: "known",
              unitOfMeasure: "case",
              supply: "100",
              used: "100.001",
              remaining: "-0.001",
            },
          },
        ],
      }),
    ).toContainEqual({ code: "balance_exhausted", path: "items[0].quantity", line: 1 });
  });

  it("blocks duplicate lot lines and invalid candidate quantity", () => {
    const issues = validateShippingReadiness({
      ...ready,
      draft: {
        ...ready.draft,
        items: [
          ready.draft.items[0]!,
          { lotId: "lot-1", quantity: "1.0001", unitOfMeasure: "case" },
        ],
      },
    });
    expect(issues).toContainEqual({ code: "duplicate", path: "items[1].lotId", line: 2 });
    expect(issues).toContainEqual({ code: "format", path: "items[1].quantity", line: 2 });
  });

  it("blocks unknown and mismatched balance units", () => {
    expect(
      validateShippingReadiness({
        ...ready,
        lots: [{ ...ready.lots[0]!, balance: { state: "unknown", reason: "mixed_uom" } }],
      }),
    ).toContainEqual({ code: "balance_unknown", path: "items[0].quantity", line: 1 });
    expect(
      validateShippingReadiness({
        ...ready,
        draft: {
          ...ready.draft,
          items: [{ lotId: "lot-1", quantity: "25", unitOfMeasure: "each" }],
        },
      }),
    ).toContainEqual({ code: "uom_mismatch", path: "items[0].unitOfMeasure", line: 1 });
  });

  it("blocks missing origin, unresolved source and controlled status", () => {
    const issues = validateShippingReadiness({
      ...ready,
      lots: [
        {
          ...ready.lots[0]!,
          tlc: null,
          sourceResolved: false,
          status: "quarantined",
          balance: { state: "unknown", reason: "no_current_origin" },
        },
      ],
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        { code: "required", path: "items[0].tlc", line: 1 },
        { code: "source_unresolved", path: "items[0].source", line: 1 },
        { code: "status_blocked", path: "items[0].lotId", line: 1 },
        { code: "origin_missing", path: "items[0].origin", line: 1 },
      ]),
    );
  });

  it("reports missing header, locations, documents, and line KDEs at stable paths", () => {
    const issues = validateShippingReadiness({
      ...ready,
      draft: {
        eventDate: null,
        timeZone: null,
        shipFromLocationId: null,
        recipientLocationId: null,
        documentIds: [],
        items: [{ lotId: null, quantity: null, unitOfMeasure: null }],
      },
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        { code: "required", path: "eventDate" },
        { code: "required", path: "timeZone" },
        { code: "required", path: "shipFromLocationId" },
        { code: "required", path: "recipientLocationId" },
        { code: "required", path: "documentIds" },
        { code: "required", path: "items[0].lotId", line: 1 },
        { code: "required", path: "items[0].quantity", line: 1 },
        { code: "required", path: "items[0].unitOfMeasure", line: 1 },
      ]),
    );
  });

  it("blocks same, unavailable, inactive, incomplete and wrong-role locations", () => {
    expect(
      validateShippingReadiness({
        ...ready,
        draft: { ...ready.draft, recipientLocationId: "processor" },
      }),
    ).toContainEqual({ code: "same_location", path: "recipientLocationId" });
    expect(
      validateShippingReadiness({
        ...ready,
        locations: [
          { ...ready.locations[0]!, roles: ["recipient"], archived: true, descriptionReady: false },
          ready.locations[1]!,
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        { code: "inactive", path: "shipFromLocationId" },
        { code: "wrong_role", path: "shipFromLocationId" },
        { code: "incomplete_description", path: "shipFromLocationId" },
      ]),
    );
    expect(
      validateShippingReadiness({ ...ready, locations: [ready.locations[0]!] }),
    ).toContainEqual({ code: "unavailable", path: "recipientLocationId" });
    expect(
      validateShippingReadiness({
        ...ready,
        locations: [ready.locations[0]!, { ...ready.locations[1]!, roles: ["supplier"] }],
      }),
    ).toContainEqual({ code: "wrong_role", path: "recipientLocationId" });
  });

  it("blocks incomplete document, product description and unresolved processor coverage", () => {
    const issues = validateShippingReadiness({
      ...ready,
      documents: [{ ...ready.documents[0]!, number: "" }],
      products: [
        {
          ...ready.products[0]!,
          descriptionReady: false,
          coverage: {
            ...reviewedCoverage,
            coverageStatus: "unknown",
            reviewedBy: null,
            reviewedAt: null,
          },
        },
      ],
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        { code: "incomplete_description", path: "documentIds" },
        { code: "incomplete_description", path: "items[0].productId", line: 1 },
        { code: "coverage_unresolved", path: "items[0].coverage", line: 1 },
      ]),
    );
    expect(
      validateShippingReadiness({
        ...ready,
        documents: [{ ...ready.documents[0]!, archived: true }],
      }),
    ).toContainEqual({ code: "inactive", path: "documentIds" });
    expect(validateShippingReadiness({ ...ready, documents: [] })).toContainEqual({
      code: "unavailable",
      path: "documentIds",
    });
  });

  it("does not label generic lot traceability as FDA coverage readiness", () => {
    expect(
      validateShippingReadiness({
        ...ready,
        profileCode: "US_GENERIC_LOT_TRACEABILITY",
        products: [
          {
            ...ready.products[0]!,
            coverage: {
              ...reviewedCoverage,
              coverageStatus: "unknown",
              reviewedBy: null,
              reviewedAt: null,
            },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("allows a predecessor-owned shipped effect for amendment recalculation only", () => {
    expect(
      validateShippingReadiness({ ...ready, lots: [{ ...ready.lots[0]!, status: "shipped" }] }),
    ).toContainEqual({ code: "status_blocked", path: "items[0].lotId", line: 1 });
    expect(
      validateShippingReadiness({
        ...ready,
        lots: [{ ...ready.lots[0]!, status: "shipped", predecessorShippingStatusOwned: true }],
      }),
    ).toEqual([]);
  });
});
