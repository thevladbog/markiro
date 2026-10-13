import { z } from "zod";
import {
  STANDALONE_FEATURE_KEYS,
  STANDALONE_QUOTA_KEYS,
  standaloneActivationRequestSchema,
} from "@markiro/domain";

import { entitlementRevisionSchema } from "./entitlements.js";
import { grantPublicKeySchema } from "./offline-grants.js";
import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

/** Plan ЛЦ-0: the SaaS admin issues signed offline licenses for «Markiro Автоном» sites. */
const innSchema = z.string().regex(/^\d{10}(\d{2})?$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const quotaLimitSchema = countSchema.nullable();
const graceDaysSchema = z.number().int().min(0).max(60);
const sequenceSchema = z.number().int().positive().max(2_147_483_647);
const platformUserIdSchema = z.string().min(1).max(128);

/**
 * The license keyset has the grant keyset's shape and checks (`grantKeysetSchema`)
 * under its own protocol literal: the license key is never the grant key.
 */
export const standaloneLicenseSigningKeysetSchema = z
  .object({
    protocol: z.literal("standalone-license-v1"),
    origin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && url.origin === value;
      }),
    revision: z.string().min(1).max(256),
    keys: z.array(grantPublicKeySchema).min(1).max(64),
    retiredKids: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict()
  .refine((value) => new Set(value.keys.map((key) => key.kid)).size === value.keys.length)
  .refine((value) => new Set(value.retiredKids).size === value.retiredKids.length);
export type StandaloneLicenseSigningKeyset = z.infer<typeof standaloneLicenseSigningKeysetSchema>;

/** Quotas and features as the file carries them: `null` quota is unlimited, features are booleans. */
export const standaloneLicenseRightsSchema = z
  .object({
    quotas: z
      .object({
        lines: quotaLimitSchema,
        stations: quotaLimitSchema,
        kiosks: quotaLimitSchema,
        cabinetUsers: quotaLimitSchema,
      })
      .strict(),
    features: z
      .object({
        labelEditor: z.boolean(),
        publicApi: z.boolean(),
        pallets: z.boolean(),
        chzIntegration: z.boolean(),
        inventory: z.boolean(),
        commerceMl: z.boolean(),
        handheld: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type StandaloneLicenseRights = z.infer<typeof standaloneLicenseRightsSchema>;

export const STANDALONE_SITE_WARNINGS = [
  "request_inn_missing",
  "request_inn_invalid",
  "org_inn_missing",
  "request_inn_differs_org",
  "request_inn_differs_billing",
  "trial_inn_differs",
] as const;
export const standaloneSiteWarningSchema = z.enum(STANDALONE_SITE_WARNINGS);
export type StandaloneSiteWarning = z.infer<typeof standaloneSiteWarningSchema>;

export const standaloneSiteHostHistorySchema = z
  .array(
    z
      .object({
        hostId: platformUuidSchema,
        requestInn: innSchema.nullable(),
        requestId: platformUuidSchema,
        boundAt: platformTimestampSchema,
        boundByPlatformUserId: platformUserIdSchema,
      })
      .strict(),
  )
  .min(1)
  .max(100);

export const standaloneIssuanceWarningSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("customer_inn_from_billing") }).strict(),
  z.object({ code: z.literal("billing_inn_differs"), billingInn: innSchema }).strict(),
  z.object({ code: z.literal("site_inn_differs"), siteInn: innSchema.nullable() }).strict(),
  z
    .object({
      code: z.literal("quota_below_usage"),
      quota: z.enum(STANDALONE_QUOTA_KEYS),
      limit: countSchema,
      used: countSchema,
    })
    .strict(),
  z
    .object({ code: z.literal("feature_unmapped"), feature: z.enum(STANDALONE_FEATURE_KEYS) })
    .strict(),
]);
export type StandaloneIssuanceWarning = z.infer<typeof standaloneIssuanceWarningSchema>;

const validUntilReasonSchema = z.enum([
  "subscription_end",
  "entitlement_reduction",
  "one_year_cap",
  "offline_term",
]);
const customerSchema = z.object({ name: z.string().min(1).max(300), inn: innSchema }).strict();
const planSchema = z.enum(["demo", "subscription"]);

/**
 * Owner decision 2026-10-13: a tenant without a cabinet gets offline licenses
 * only. Its rights come from offline terms the operator enters per issuance —
 * a published catalog plan version (quotas and features) and a term of 1-365
 * days from the issuance; no unlimited term. A tenant with a cabinet keeps the
 * subscription-derived path. Nothing of it reaches the cloud entitlements.
 */
export const STANDALONE_ISSUANCE_SOURCES = ["subscription", "offline"] as const;
export const standaloneIssuanceSourceSchema = z.enum(STANDALONE_ISSUANCE_SOURCES);
export type StandaloneIssuanceSource = z.infer<typeof standaloneIssuanceSourceSchema>;
export const STANDALONE_OFFLINE_TERM_MAX_DAYS = 365;
export const standaloneOfflineTermsSchema = z
  .object({
    planVersionId: platformUuidSchema,
    termDays: z.number().int().min(1).max(STANDALONE_OFFLINE_TERM_MAX_DAYS),
  })
  .strict();
export type StandaloneOfflineTerms = z.infer<typeof standaloneOfflineTermsSchema>;

/** An offline file is a paid plan whose term the operator set; a cloud file never is. */
function sourceMatchesReason(value: {
  source: StandaloneIssuanceSource;
  plan: "demo" | "subscription";
  validUntilReason: z.infer<typeof validUntilReasonSchema>;
}): boolean {
  return value.source === "offline"
    ? value.validUntilReason === "offline_term" && value.plan === "subscription"
    : value.validUntilReason !== "offline_term";
}

export const standaloneIssuanceSummarySchema = z
  .object({
    licenseId: platformUuidSchema,
    siteId: platformUuidSchema,
    sequence: sequenceSchema,
    hostId: platformUuidSchema,
    source: standaloneIssuanceSourceSchema,
    plan: planSchema,
    planVersionId: platformUuidSchema,
    entitlementRevision: entitlementRevisionSchema,
    validFrom: platformTimestampSchema,
    validUntil: platformTimestampSchema,
    validUntilReason: validUntilReasonSchema,
    graceDays: graceDaysSchema,
    kid: z.string().min(1).max(128),
    sha256: sha256Schema,
    issuedAt: platformTimestampSchema,
    issuedByPlatformUserId: platformUserIdSchema,
    replaces: platformUuidSchema.nullable(),
    customer: customerSchema,
    rights: standaloneLicenseRightsSchema,
  })
  .strict()
  .refine(sourceMatchesReason);
export type StandaloneIssuanceSummary = z.infer<typeof standaloneIssuanceSummarySchema>;

const siteUsageSchema = z
  .object({ stations: countSchema, cabinetUsers: countSchema, lines: countSchema })
  .strict();

export const standaloneSiteSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    hostId: platformUuidSchema,
    name: z.string().min(1).max(200),
    requestInn: innSchema.nullable(),
    hostVersion: z.string().min(1).max(64).nullable(),
    usage: siteUsageSchema.nullable(),
    requestCreatedAt: platformTimestampSchema.nullable(),
    hostHistory: standaloneSiteHostHistorySchema,
    lastIssuedSequence: z.number().int().nonnegative(),
    latestIssuance: standaloneIssuanceSummarySchema.nullable(),
    renewalDue: z.boolean(),
    createdAt: platformTimestampSchema,
  })
  .strict();
export type StandaloneSite = z.infer<typeof standaloneSiteSchema>;

export const standaloneSiteListSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    signingConfigured: z.boolean(),
    /** Which path this tenant's files take: `offline` for a tenant without a cabinet. */
    issuanceSource: standaloneIssuanceSourceSchema,
    sites: z.array(standaloneSiteSchema).max(500),
  })
  .strict();
export type StandaloneSiteList = z.infer<typeof standaloneSiteListSchema>;

export const standaloneSiteInspectRequestSchema = z
  .object({ request: standaloneActivationRequestSchema })
  .strict();
export type StandaloneSiteInspectRequest = z.infer<typeof standaloneSiteInspectRequestSchema>;

export const standaloneSiteInspectionSchema = z
  .object({
    hostId: platformUuidSchema,
    hostVersion: z.string().min(1).max(64).nullable(),
    organizationName: z.string().max(500).nullable(),
    usage: siteUsageSchema,
    innFacts: z
      .object({
        requestInn: innSchema.nullable(),
        orgInn: innSchema.nullable(),
        billingInn: innSchema.nullable(),
        trialInn: innSchema.nullable(),
      })
      .strict(),
    warnings: z.array(standaloneSiteWarningSchema).max(STANDALONE_SITE_WARNINGS.length),
    blocking: z.enum(["host_registered", "host_taken"]).nullable(),
    registeredSite: z
      .object({ id: platformUuidSchema, name: z.string().min(1).max(200) })
      .strict()
      .nullable(),
  })
  .strict();
export type StandaloneSiteInspection = z.infer<typeof standaloneSiteInspectionSchema>;

const acknowledgedWarningsSchema = z
  .array(standaloneSiteWarningSchema)
  .max(STANDALONE_SITE_WARNINGS.length);
export const standaloneSiteRegisterSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("create"),
      requestId: platformUuidSchema,
      name: z.string().trim().min(1).max(200),
      request: standaloneActivationRequestSchema,
      acknowledgedWarnings: acknowledgedWarningsSchema,
    })
    .strict(),
  z
    .object({
      intent: z.literal("rebind"),
      requestId: platformUuidSchema,
      siteId: platformUuidSchema,
      request: standaloneActivationRequestSchema,
      acknowledgedWarnings: acknowledgedWarningsSchema,
    })
    .strict(),
]);
export type StandaloneSiteRegister = z.infer<typeof standaloneSiteRegisterSchema>;

export const standaloneIssuancePreviewRequestSchema = z
  .object({
    graceDays: graceDaysSchema.nullable(),
    offline: standaloneOfflineTermsSchema.nullable(),
  })
  .strict();
export type StandaloneIssuancePreviewRequest = z.infer<
  typeof standaloneIssuancePreviewRequestSchema
>;

/** What the operator saw; confirmation recomputes and refuses when any of it moved. */
export const standaloneIssuanceExpectationSchema = z
  .object({
    entitlementRevision: entitlementRevisionSchema,
    previousSequence: z.number().int().nonnegative().max(2_147_483_647),
    boundaryAt: platformTimestampSchema.nullable(),
    /**
     * SHA-256 of everything the file would sign apart from its instants: source,
     * plan, plan version, grace, host, customer, rights, offline terms, reason.
     */
    termsDigest: sha256Schema,
  })
  .strict();

export const standaloneIssuancePreviewSchema = z
  .object({
    siteId: platformUuidSchema,
    hostId: platformUuidSchema,
    previous: standaloneIssuanceSummarySchema.nullable(),
    next: z
      .object({
        sequence: sequenceSchema,
        source: standaloneIssuanceSourceSchema,
        plan: planSchema,
        planVersionId: platformUuidSchema,
        entitlementRevision: entitlementRevisionSchema,
        validFrom: platformTimestampSchema,
        validUntil: platformTimestampSchema,
        validUntilReason: validUntilReasonSchema,
        graceDays: graceDaysSchema,
        customer: customerSchema,
        rights: standaloneLicenseRightsSchema,
      })
      .strict()
      .refine(sourceMatchesReason),
    warnings: z.array(standaloneIssuanceWarningSchema).max(32),
    expected: standaloneIssuanceExpectationSchema,
  })
  .strict();
export type StandaloneIssuancePreview = z.infer<typeof standaloneIssuancePreviewSchema>;

export const standaloneIssuanceConfirmSchema = z
  .object({
    requestId: platformUuidSchema,
    graceDays: graceDaysSchema.nullable(),
    offline: standaloneOfflineTermsSchema.nullable(),
    expected: standaloneIssuanceExpectationSchema,
  })
  .strict();
export type StandaloneIssuanceConfirm = z.infer<typeof standaloneIssuanceConfirmSchema>;

export const standaloneLicenseFileSchema = z
  .object({
    issuance: standaloneIssuanceSummarySchema,
    fileName: z.string().regex(/^markiro-[0-9a-f]{8}-\d{3,}\.mklic$/),
    compact: z.string().min(1).max(16_384),
    sha256: sha256Schema,
  })
  .strict();
export type StandaloneLicenseFile = z.infer<typeof standaloneLicenseFileSchema>;

export const standaloneIssuanceListSchema = z
  .object({
    siteId: platformUuidSchema,
    items: z.array(standaloneIssuanceSummarySchema).max(1_000),
  })
  .strict();
export type StandaloneIssuanceList = z.infer<typeof standaloneIssuanceListSchema>;

const sites = "/platform/tenants/:tenantId/standalone-sites";
export const platformStandaloneLicenseContracts = {
  list: { method: "GET", path: sites, response: standaloneSiteListSchema },
  inspect: {
    method: "POST",
    path: `${sites}/inspect`,
    body: standaloneSiteInspectRequestSchema,
    response: standaloneSiteInspectionSchema,
  },
  register: {
    method: "POST",
    path: sites,
    body: standaloneSiteRegisterSchema,
    response: standaloneSiteSchema,
  },
  previewIssuance: {
    method: "POST",
    path: `${sites}/:siteId/issuances/preview`,
    body: standaloneIssuancePreviewRequestSchema,
    response: standaloneIssuancePreviewSchema,
  },
  confirmIssuance: {
    method: "POST",
    path: `${sites}/:siteId/issuances`,
    body: standaloneIssuanceConfirmSchema,
    response: standaloneLicenseFileSchema,
  },
  listIssuances: {
    method: "GET",
    path: `${sites}/:siteId/issuances`,
    response: standaloneIssuanceListSchema,
  },
  download: {
    method: "GET",
    path: `${sites}/:siteId/issuances/:licenseId/file`,
    response: standaloneLicenseFileSchema,
  },
} as const;
