import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

function at<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing fixture row ${index}`);
  return value;
}

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

const review = {
  reason: "  Receipt-specific rationale  ",
  evidenceUrl: "https://例え.テスト/Ä",
  reviewedBy: "qa-user",
  reviewedAt: "2026-09-07T10:00:00.000Z",
};
const item = at(snapshot.items, 0);
function v2(basis: unknown = { kind: "ordinary" }) {
  return {
    ...snapshot,
    snapshotVersion: 2,
    items: [{ ...item, receiptBasis: basis }],
    confirmation: {
      ...snapshot.confirmation,
      ruleVersion: "receiving-readiness-v3",
      reviewedExemptLines: [] as number[],
    },
  };
}
function preserved() {
  const value = v2({ kind: "exempt_existing_tlc", ...review });
  value.confirmation.reviewedExemptLines = [1];
  return value;
}
function assigned() {
  const value = preserved();
  return {
    ...value,
    items: [
      {
        ...item,
        source: { kind: "location", locationId: receivingLocationId },
        sourceDescription: snapshot.locationDescription,
        receiptBasis: { kind: "exempt_assigned_tlc", ...review, receivedTlc: null },
      },
    ],
  };
}
describe("independent frozen receiving v2 contracts", () => {
  it.each([
    ["ordinary", v2],
    ["preserved", preserved],
    ["assigned", assigned],
  ])("preserves exact %s content", (_label, build) => {
    const input = build();
    expect(contracts.receivingFinalizationSnapshotV2Schema.parse(input)).toEqual(input);
    expect(contracts.receivingFinalizationSnapshotSchema.parse(input)).toEqual(input);
  });
  it.each([
    ["root key", { ...preserved(), forged: true }],
    ["item key", { ...preserved(), items: [{ ...at(preserved().items, 0), forged: true }] }],
    ["basis key", v2({ kind: "ordinary", reason: "forged" })],
    ["missing basis", { ...v2(), items: [item] }],
    ["missing review", v2({ kind: "exempt_existing_tlc" })],
    [
      "missing reviewed lines",
      {
        ...v2(),
        confirmation: { ...snapshot.confirmation, ruleVersion: "receiving-readiness-v3" },
      },
    ],
    ["missing required review", { ...preserved(), confirmation: v2().confirmation }],
    ["extra review", { ...v2(), confirmation: { ...v2().confirmation, reviewedExemptLines: [1] } }],
    [
      "duplicate review",
      {
        ...preserved(),
        confirmation: { ...preserved().confirmation, reviewedExemptLines: [1, 1] },
      },
    ],
    [
      "unordered reviews",
      {
        ...preserved(),
        confirmation: { ...preserved().confirmation, reviewedExemptLines: [2, 1] },
      },
    ],
    [
      "fractional review",
      { ...preserved(), confirmation: { ...preserved().confirmation, reviewedExemptLines: [1.5] } },
    ],
    [
      "out of range review",
      { ...preserved(), confirmation: { ...preserved().confirmation, reviewedExemptLines: [101] } },
    ],
    [
      "wrong own source",
      {
        ...assigned(),
        items: [
          {
            ...at(assigned().items, 0),
            source: { kind: "location", locationId: sourceLocationId },
            sourceDescription: snapshot.previousSourceDescription,
          },
        ],
      },
    ],
    [
      "own link mode",
      { ...assigned(), items: [{ ...at(assigned().items, 0), lotLinkMode: "link_existing" }] },
    ],
    [
      "own received TLC",
      {
        ...assigned(),
        items: [
          {
            ...at(assigned().items, 0),
            receiptBasis: { kind: "exempt_assigned_tlc", ...review, receivedTlc: "old" },
          },
        ],
      },
    ],
    [
      "preserved source description",
      {
        ...preserved(),
        items: [{ ...at(preserved().items, 0), sourceDescription: snapshot.locationDescription }],
      },
    ],
    ["product relationship", { ...v2(), items: [{ ...at(v2().items, 0), productId: otherId }] }],
    [
      "document relationship",
      { ...v2(), documents: [{ ...at(snapshot.documents, 0), issuer: null }] },
    ],
    ["missing FSMA document", { ...v2(), documents: [] }],
    [
      "invalid coverage",
      {
        ...v2(),
        items: [{ ...at(v2().items, 0), coverage: { ...item.coverage, reviewedBy: null } }],
      },
    ],
    ["noncanonical quantity", { ...v2(), items: [{ ...at(v2().items, 0), quantity: "0500.000" }] }],
    [
      "v1 rule",
      { ...v2(), confirmation: { ...v2().confirmation, ruleVersion: "receiving-readiness-v2" } },
    ],
    [
      "new warning vocabulary",
      {
        ...v2(),
        confirmation: {
          ...v2().confirmation,
          warnings: [
            {
              severity: "warning",
              group: "lines",
              line: 1,
              field: "exemption",
              code: "evidence_required",
              detail: null,
            },
          ],
        },
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(contracts.receivingFinalizationSnapshotV2Schema.safeParse(value).success).toBe(false);
  });
  it.each(["", " ", "x".repeat(2001), "\u0000", "\ud800"])(
    "rejects invalid reason %j",
    (reason) => {
      const value = preserved();
      value.items[0] = {
        ...item,
        receiptBasis: { kind: "exempt_existing_tlc", ...review, reason },
      };
      expect(contracts.receivingFinalizationSnapshotV2Schema.safeParse(value).success).toBe(false);
    },
  );
  it.each([
    "not a URL",
    "https://user:password@example.test",
    "https://xn--/",
    "https://example.test/" + "é".repeat(510),
  ])("rejects invalid evidence %j", (evidenceUrl) => {
    const value = preserved();
    value.items[0] = {
      ...item,
      receiptBasis: { kind: "exempt_existing_tlc", ...review, evidenceUrl },
    };
    expect(contracts.receivingFinalizationSnapshotV2Schema.safeParse(value).success).toBe(false);
  });
});
