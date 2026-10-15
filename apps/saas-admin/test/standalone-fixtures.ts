import {
  standaloneIssuancePreviewSchema,
  standaloneIssuanceSummarySchema,
  standaloneLicenseFileSchema,
  standaloneSiteInspectionSchema,
  standaloneSiteListSchema,
  standaloneSiteSchema,
} from "@markiro/platform-contracts";

export const STANDALONE_TENANT_ID = "81111111-1111-4111-8111-111111111111";
export const STANDALONE_SITE_ID = "a1111111-1111-4111-8111-111111111111";
export const STANDALONE_HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const STANDALONE_LICENSE_ID = "b1111111-1111-4111-8111-111111111111";
const PLAN_VERSION_ID = "c1111111-1111-4111-8111-111111111111";
const CUSTOMER = { name: "ООО «Первый завод»", inn: "7707083893" };
const RIGHTS = {
  quotas: { lines: 2, stations: 3, kiosks: 0, cabinetUsers: 5 },
  features: {
    labelEditor: true,
    publicApi: false,
    pallets: true,
    chzIntegration: false,
    inventory: false,
    commerceMl: false,
    handheld: false,
    customLogo: false,
  },
};

// Far-future dates keep the license phase deterministic whenever the suite runs.
export const STANDALONE_ISSUANCE = standaloneIssuanceSummarySchema.parse({
  licenseId: STANDALONE_LICENSE_ID,
  siteId: STANDALONE_SITE_ID,
  sequence: 1,
  hostId: STANDALONE_HOST_ID,
  source: "subscription",
  plan: "subscription",
  planVersionId: PLAN_VERSION_ID,
  entitlementRevision: "7",
  validFrom: "2099-10-01T09:00:00.000Z",
  validUntil: "2099-11-01T09:00:00.000Z",
  validUntilReason: "subscription_end",
  graceDays: 14,
  kid: "lic-2026-1",
  sha256: "a".repeat(64),
  issuedAt: "2099-10-01T09:00:00.000Z",
  issuedByPlatformUserId: "fixture-admin",
  replaces: null,
  customer: CUSTOMER,
  rights: RIGHTS,
});

export const STANDALONE_SITE = standaloneSiteSchema.parse({
  id: STANDALONE_SITE_ID,
  tenantId: STANDALONE_TENANT_ID,
  hostId: STANDALONE_HOST_ID,
  name: "Цех розлива",
  requestInn: "7707083893",
  hostVersion: "0.3.0",
  usage: { stations: 2, cabinetUsers: 1, lines: 3 },
  requestCreatedAt: "2099-09-30T09:00:00.000Z",
  hostHistory: [
    {
      hostId: STANDALONE_HOST_ID,
      requestInn: "7707083893",
      requestId: "d1111111-1111-4111-8111-111111111111",
      boundAt: "2099-09-30T10:00:00.000Z",
      boundByPlatformUserId: "fixture-admin",
    },
  ],
  lastIssuedSequence: 1,
  latestIssuance: STANDALONE_ISSUANCE,
  renewalDue: true,
  createdAt: "2099-09-30T10:00:00.000Z",
});

export const STANDALONE_SITE_LIST = standaloneSiteListSchema.parse({
  tenantId: STANDALONE_TENANT_ID,
  signingConfigured: true,
  issuanceSource: "subscription",
  sites: [STANDALONE_SITE],
});

export const STANDALONE_FILE = standaloneLicenseFileSchema.parse({
  issuance: STANDALONE_ISSUANCE,
  fileName: "markiro-3f1c2d4e-001.mklic",
  compact: "eyJhbGciOiJFUzI1NiJ9.eyJ2ZXJzaW9uIjoxfQ.c2lnbmF0dXJl",
  sha256: "a".repeat(64),
});

export const STANDALONE_PREVIEW = standaloneIssuancePreviewSchema.parse({
  siteId: STANDALONE_SITE_ID,
  hostId: STANDALONE_HOST_ID,
  previous: STANDALONE_ISSUANCE,
  next: {
    sequence: 2,
    source: "subscription",
    plan: "subscription",
    planVersionId: PLAN_VERSION_ID,
    entitlementRevision: "8",
    validFrom: "2099-10-20T09:00:00.000Z",
    validUntil: "2100-10-01T09:00:00.000Z",
    validUntilReason: "entitlement_reduction",
    graceDays: 14,
    customer: CUSTOMER,
    rights: {
      quotas: { ...RIGHTS.quotas, stations: 5 },
      features: { ...RIGHTS.features, handheld: true },
    },
  },
  warnings: [
    { code: "quota_below_usage", quota: "lines", limit: 2, used: 3 },
    { code: "feature_unmapped", feature: "chzIntegration" },
  ],
  expected: {
    entitlementRevision: "8",
    previousSequence: 1,
    boundaryAt: "2100-10-01T09:00:00.000Z",
    termsDigest: "c".repeat(64),
  },
});

export const STANDALONE_INSPECTION = standaloneSiteInspectionSchema.parse({
  hostId: "e1111111-1111-4111-8111-111111111111",
  hostVersion: "0.3.0",
  organizationName: "ООО «Первый завод»",
  usage: { stations: 2, cabinetUsers: 1, lines: 1 },
  innFacts: { requestInn: "7736207543", orgInn: "7707083893", billingInn: null, trialInn: null },
  warnings: ["request_inn_differs_org"],
  blocking: null,
  registeredSite: null,
});
