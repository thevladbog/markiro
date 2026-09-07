import type {
  ReceivingDraftRecord,
  ReceivingFinalizedRecord,
  ReceivingReadiness,
} from "@markiro/platform-contracts";

export const eventId = "c0000000-0000-4000-8000-000000000001";
export const receivingLocationId = "c0000000-0000-4000-8000-000000000002";
export const previousLocationId = "c0000000-0000-4000-8000-000000000003";
export const productId = "c0000000-0000-4000-8000-000000000004";
export const firstLotId = "c0000000-0000-4000-8000-000000000005";
export const secondLotId = "c0000000-0000-4000-8000-000000000006";
export const operationKey = "d0000000-0000-4000-8000-000000000001";
export const receivingPath = "/api/us/traceability/receiving";
export const timestamp = "2026-09-07T18:30:00.000Z";

export const product = {
  id: productId,
  name: "Frozen heritage apples",
  gtin14: null,
  archived: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};

export const receivingLocation = {
  id: receivingLocationId,
  partyId: eventId,
  name: "North River receiving dock",
  businessName: "North River Fresh Foods",
  phoneNumber: "+1 509 555 0100",
  addressKind: "street" as const,
  streetAddress: "900 Receiving Way",
  latitude: null,
  longitude: null,
  city: "Yakima",
  stateOrRegion: "WA",
  zipOrPostalCode: "98901",
  countryCode: "US",
  roles: ["receive_at" as const, "tlc_source" as const],
  archived: false,
  createdAt: timestamp,
  updatedAt: timestamp,
  descriptionStatus: { exportReady: true, issues: [] },
};

export const previousLocation = {
  ...receivingLocation,
  id: previousLocationId,
  name: "Cascade supplier cold store",
  businessName: "Cascade Orchard Cooperative",
  streetAddress: "17 Orchard Road",
  roles: ["supplier" as const, "tlc_source" as const],
};

const frozenLocation = (location: {
  id: string;
  partyId: string;
  businessName: string;
  phoneNumber: string;
  streetAddress: string | null;
  city: string;
  stateOrRegion: string;
  zipOrPostalCode: string | null;
}) => ({
  schemaVersion: 1 as const,
  locationId: location.id,
  partyId: location.partyId,
  businessName: location.businessName,
  phoneNumber: location.phoneNumber,
  address: { kind: "street" as const, streetAddress: location.streetAddress ?? "" },
  city: location.city,
  stateOrRegion: location.stateOrRegion,
  zipOrPostalCode: location.zipOrPostalCode ?? "",
  countryCode: "US",
  countryDisplay: "United States",
});

export const exemptionRecord: ReceivingDraftRecord = {
  id: eventId,
  eventNumber: "REC-26-4001",
  status: "draft",
  revision: 1,
  draftVersion: 4,
  timeZone: "America/Los_Angeles",
  createdBy: "receiver-user",
  updatedBy: "receiver-user",
  createdAt: timestamp,
  updatedAt: timestamp,
  draft: {
    dateReceived: "2026-09-07",
    locationId: receivingLocationId,
    previousSourceLocationId: previousLocationId,
    receivedAtNote: "Dock 7",
    notes: null,
    documentIds: [],
    items: [
      {
        productId,
        lotLinkMode: "create_on_finalize",
        lotId: null,
        tlc: "SUPPLIER-TLC-01",
        source: { kind: "location", locationId: previousLocationId },
        exemptSupplier: true,
        exemptReason: "Supplier declaration for this shipment",
        exemptReceipt: {
          evidenceUrl: "https://supplier.example.test/declarations/receipt-4001",
          tlcHandling: "preserve_existing",
          proposedTlc: null,
        },
        supplierLotReference: "VENDOR-LOT-A",
        quantity: "25.000",
        unitOfMeasure: "lb",
        notes: null,
      },
      {
        productId,
        lotLinkMode: "create_on_finalize",
        lotId: null,
        tlc: null,
        source: { kind: "location", locationId: receivingLocationId },
        exemptSupplier: true,
        exemptReason: "No TLC arrived with the exempt shipment",
        exemptReceipt: {
          evidenceUrl: "https://supplier.example.test/declarations/receipt-4001-line-2",
          tlcHandling: "assign_if_missing",
          proposedTlc: "=OWN/Ä-4001",
        },
        supplierLotReference: "VENDOR-LOT-B",
        quantity: "10.500",
        unitOfMeasure: "lb",
        notes: null,
      },
    ],
  },
};

export const exemptionReadiness: ReceivingReadiness = {
  eventId,
  draftVersion: 4,
  checkedAt: timestamp,
  inputDigest: "c".repeat(64),
  ruleVersion: "receiving-readiness-v3",
  profileCode: "US_GENERIC_LOT_TRACEABILITY",
  state: "complete",
  issues: [],
  exemptReviewRequiredLines: [1, 2],
};

const productDescription = {
  snapshotVersion: 1 as const,
  sourceProductId: productId,
  productName: product.name,
  brandName: null,
  commodity: null,
  variety: null,
  packagingSize: null,
  packagingStyle: null,
  gtin: null,
};
const coverage = {
  coverageStatus: "unknown" as const,
  coverageRationale: null,
  ftlCategory: null,
  ftlSourceUrl: null,
  ftlSourceVersion: null,
  reviewedBy: null,
  reviewedAt: null,
};
const review = {
  reason: "Supplier declaration for this shipment",
  evidenceUrl: "https://supplier.example.test/declarations/receipt-4001",
  reviewedBy: "qa-user",
  reviewedAt: timestamp,
};

export const exemptionFinalized: ReceivingFinalizedRecord = {
  id: eventId,
  eventNumber: exemptionRecord.eventNumber,
  status: "finalized",
  revision: 1,
  draftVersion: 4,
  timeZone: exemptionRecord.timeZone,
  createdBy: exemptionRecord.createdBy,
  updatedBy: "qa-user",
  createdAt: timestamp,
  updatedAt: timestamp,
  finalizedAt: timestamp,
  finalizedBy: "qa-user",
  snapshot: {
    snapshotVersion: 2,
    dateReceived: "2026-09-07",
    locationId: receivingLocationId,
    previousSourceLocationId: previousLocationId,
    receivedAtNote: "Dock 7",
    notes: null,
    profileCode: "US_GENERIC_LOT_TRACEABILITY",
    baselineVersion: "US-REG-2026-09-03",
    locationDescription: frozenLocation(receivingLocation),
    previousSourceDescription: frozenLocation(previousLocation),
    documents: [],
    items: [
      {
        lineNo: 1,
        productId,
        lotId: firstLotId,
        lotLinkMode: "create_on_finalize",
        tlc: "SUPPLIER-TLC-01",
        source: { kind: "location", locationId: previousLocationId },
        quantity: "25.000",
        unitOfMeasure: "lb",
        supplierLotReference: "VENDOR-LOT-A",
        notes: null,
        sourceDescription: frozenLocation(previousLocation),
        productDescription,
        coverage,
        receiptBasis: { kind: "exempt_existing_tlc", ...review },
      },
      {
        lineNo: 2,
        productId,
        lotId: secondLotId,
        lotLinkMode: "create_on_finalize",
        tlc: "=OWN/Ä-4001",
        source: { kind: "location", locationId: receivingLocationId },
        quantity: "10.500",
        unitOfMeasure: "lb",
        supplierLotReference: "VENDOR-LOT-B",
        notes: null,
        sourceDescription: frozenLocation(receivingLocation),
        productDescription,
        coverage,
        receiptBasis: {
          kind: "exempt_assigned_tlc",
          reason: "No TLC arrived with the exempt shipment",
          evidenceUrl: "https://supplier.example.test/declarations/receipt-4001-line-2",
          reviewedBy: "qa-user",
          reviewedAt: timestamp,
          receivedTlc: null,
        },
      },
    ],
    confirmation: {
      ruleVersion: "receiving-readiness-v3",
      inputDigest: exemptionReadiness.inputDigest,
      warnings: [],
      reviewedExemptLines: [1, 2],
    },
  },
};
