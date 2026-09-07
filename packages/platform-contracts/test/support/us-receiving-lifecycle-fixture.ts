// Independent copy of the pre-lifecycle frozen specimen; legacy tests stay unchanged.
export const productId = "ABCDEFAB-0000-4000-8000-000000000003";
export const lotId = "ABCDEFAB-0000-4000-8000-000000000004";
export const receivingLocationId = "ABCDEFAB-0000-4000-8000-000000000005";
export const sourceLocationId = "ABCDEFAB-0000-4000-8000-000000000006";
export const issuerId = "ABCDEFAB-0000-4000-8000-000000000007";
export const documentId = "ABCDEFAB-0000-4000-8000-000000000008";
export const otherId = "ABCDEFAB-0000-4000-8000-000000000099";

export const locationDescription = (locationId: string, businessName: string) => ({
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

export const snapshotV1 = {
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

export const review = {
  reason: "  Receipt-specific rationale  ",
  evidenceUrl: "https://例え.テスト/Ä",
  reviewedBy: "qa-user",
  reviewedAt: "2026-09-07T10:00:00.000Z",
};

export const eventId = "ABCDEFAB-0000-4000-8000-000000000001";
export const successorId = "ABCDEFAB-0000-4000-8000-000000000002";
export function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing specimen row");
  return value;
}
export const snapshotV2 = {
  ...snapshotV1,
  snapshotVersion: 2 as const,
  items: snapshotV1.items.map((item) => ({ ...item, receiptBasis: { kind: "ordinary" as const } })),
  confirmation: {
    ...snapshotV1.confirmation,
    ruleVersion: "receiving-readiness-v3" as const,
    reviewedExemptLines: [],
  },
};
export const snapshotV3 = {
  ...snapshotV2,
  snapshotVersion: 3 as const,
  items: snapshotV2.items.map((item) => ({ ...item, lotBinding: { kind: "created" as const } })),
  confirmation: { ...snapshotV2.confirmation, ruleVersion: "receiving-readiness-v4" as const },
};
export const draft = {
  dateReceived: null,
  locationId: receivingLocationId,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: "  Saved draft note  ",
  items: [],
  documentIds: [],
};
export const header = {
  id: eventId,
  eventNumber: "REC-26-0001",
  revision: 1 as const,
  draftVersion: 7,
  timeZone: "America/Chicago",
  createdBy: "creator",
  updatedBy: "qa-user",
  createdAt: "2026-09-07T09:00:00.000Z",
  updatedAt: "2026-09-07T10:00:00.000Z",
};
export const finalized = {
  ...header,
  status: "finalized" as const,
  finalizedAt: header.updatedAt,
  finalizedBy: header.updatedBy,
  snapshot: snapshotV1,
};
export const lifecycle = {
  rootId: eventId,
  lifecycleVersion: 2,
  previousRevisionId: null,
  supersededByEventId: null,
  currentEventId: eventId,
  pendingDraftId: null,
  amendmentReason: null,
  supersededAt: null,
  supersededBy: null,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
};
export const liveFinalized = {
  ...header,
  recordVersion: 2 as const,
  status: "finalized" as const,
  lifecycle,
  content: {
    kind: "finalized" as const,
    finalizedAt: header.updatedAt,
    finalizedBy: header.updatedBy,
    snapshot: snapshotV3,
  },
};
