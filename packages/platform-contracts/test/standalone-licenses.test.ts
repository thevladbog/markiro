import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STANDALONE_FEATURE_KEYS,
  STANDALONE_OPAQUE_ID_PATTERN,
  STANDALONE_QUOTA_KEYS,
  standaloneActivationRequestSchema,
  standaloneLicensePayloadV1Schema,
} from "@markiro/domain";
import {
  platformStandaloneLicenseContracts,
  STANDALONE_ASSIGNMENT_REFS_MAX,
  standaloneAssignmentRefsSchema,
  standaloneIssuanceConfirmSchema,
  standaloneIssuancePreviewRequestSchema,
  standaloneIssuanceSummarySchema,
  standaloneIssuanceWarningSchema,
  STANDALONE_ISSUANCE_SOURCES,
  standaloneLicenseFileSchema,
  standaloneLicenseSigningKeysetSchema,
  standaloneLicenseRightsSchema,
  standaloneSiteRegisterSchema,
  standaloneSiteSchema,
  standaloneActivationExportSchema,
  STANDALONE_DEMO_PLAN_VERSION_ID,
  STANDALONE_DEMO_TERM_MAX_DAYS,
  standaloneDemoTermsSchema,
  standaloneIssuancePreviewSchema,
} from "../src/index.js";

const ORIGIN = "https://api.example.invalid";
const request = standaloneActivationRequestSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../../domain/fixtures/standalone-license/activation-request.json", import.meta.url),
      "utf8",
    ),
  ),
);

function publicJwk() {
  const jwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
    format: "jwk",
  });
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

function keyset(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "standalone-license-v1",
    origin: ORIGIN,
    revision: "lic-v1",
    keys: [{ kid: "lic-1", jwk: publicJwk() }],
    retiredKids: [],
    ...overrides,
  };
}

describe("standalone license keyset (plan ЛЦ-0, Д11)", () => {
  it("accepts the grant keyset shape under its own protocol literal", () => {
    expect(standaloneLicenseSigningKeysetSchema.parse(keyset()).keys[0]?.kid).toBe("lic-1");
  });

  it("refuses the grant protocol literal, a path origin, duplicate kids and duplicate retired kids", () => {
    const key = { kid: "lic-1", jwk: publicJwk() };
    for (const invalid of [
      keyset({ protocol: "offline-grants-v1" }),
      keyset({ origin: `${ORIGIN}/` }),
      keyset({ origin: `${ORIGIN}/licenses` }),
      keyset({ keys: [key, key] }),
      keyset({ retiredKids: ["old", "old"] }),
      keyset({ keys: [{ kid: "lic-1", jwk: { ...publicJwk(), d: "private" } }] }),
      { ...keyset(), extra: true },
    ]) {
      expect(standaloneLicenseSigningKeysetSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("standalone license rights", () => {
  it("names exactly the cloud quota and feature keys the payload carries", () => {
    expect(Object.keys(standaloneLicenseRightsSchema.shape.quotas.shape)).toEqual([
      ...STANDALONE_QUOTA_KEYS,
    ]);
    expect(Object.keys(standaloneLicenseRightsSchema.shape.features.shape)).toEqual([
      ...STANDALONE_FEATURE_KEYS,
    ]);
  });

  it("keeps null as unlimited for quotas and refuses null features", () => {
    const rights = {
      quotas: { lines: null, stations: 3, kiosks: 0, cabinetUsers: 5 },
      features: {
        labelEditor: true,
        publicApi: false,
        pallets: true,
        chzIntegration: false,
        inventory: false,
        commerceMl: false,
        handheld: true,
        customLogo: false,
      },
    };
    expect(standaloneLicenseRightsSchema.parse(rights)).toEqual(rights);
    expect(
      standaloneLicenseRightsSchema.safeParse({
        ...rights,
        features: { ...rights.features, handheld: null },
      }).success,
    ).toBe(false);
  });
});

describe("standalone license payload tenant id (owner decision 2026-10-13)", () => {
  const payload = {
    version: 1,
    licenseId: randomUUID(),
    sequence: 1,
    issuer: ORIGIN,
    tenantId: randomUUID(),
    siteId: randomUUID(),
    hostId: request.hostId,
    customer: { name: "ООО «Завод»", inn: "7707083893" },
    plan: "subscription",
    planVersionId: randomUUID(),
    entitlementRevision: "7",
    issuedAt: 1_792_000_000_000,
    validFrom: 1_792_000_000_000,
    validUntil: 1_799_000_000_000,
    graceDays: 14,
    quotas: { lines: null, stations: 3, kiosks: 0, cabinetUsers: 5 },
    features: {
      labelEditor: true,
      publicApi: false,
      pallets: true,
      chzIntegration: false,
      inventory: false,
      commerceMl: false,
      handheld: true,
      customLogo: false,
    },
    replaces: null,
  };

  it("accepts a platform UUID and a cabinet-era Better Auth id the counterparty chose", () => {
    for (const tenantId of [randomUUID(), "Zq4bL0x9cabinetTenant01", "a", "x".repeat(64)]) {
      expect(standaloneLicensePayloadV1Schema.safeParse({ ...payload, tenantId }).success).toBe(
        true,
      );
      expect(STANDALONE_OPAQUE_ID_PATTERN.test(tenantId)).toBe(true);
    }
  });

  it("refuses an empty, too long, spaced, control-character or look-alike tenant id", () => {
    for (const tenantId of [
      "",
      "x".repeat(65),
      "tenant 1",
      "tenant\u0000",
      "tenant\n",
      "tenant/1",
      "t\u0435nant",
      "ｔenant",
    ]) {
      expect(standaloneLicensePayloadV1Schema.safeParse({ ...payload, tenantId }).success).toBe(
        false,
      );
    }
  });
});

describe("standalone site registration body", () => {
  const base = { requestId: randomUUID(), request, acknowledgedWarnings: [] };

  it("accepts a new site and a new host id for an existing site", () => {
    expect(
      standaloneSiteRegisterSchema.parse({ ...base, intent: "create", name: "  Цех  " }),
    ).toMatchObject({ intent: "create", name: "Цех" });
    const siteId = randomUUID();
    expect(standaloneSiteRegisterSchema.parse({ ...base, intent: "rebind", siteId })).toMatchObject(
      { intent: "rebind", siteId },
    );
  });

  it("refuses a blank name, an unknown warning, an unknown field and a malformed request", () => {
    for (const invalid of [
      { ...base, intent: "create", name: "   " },
      { ...base, intent: "create", name: "Цех", acknowledgedWarnings: ["inn_whatever"] },
      { ...base, intent: "create", name: "Цех", tenantId: "other" },
      { ...base, intent: "create", name: "Цех", request: { ...request, extra: 1 } },
      { ...base, intent: "rebind", name: "Цех" },
    ]) {
      expect(standaloneSiteRegisterSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("standalone issuance confirmation and file", () => {
  it("requires the preview expectation and bounds grace days", () => {
    const expected = {
      entitlementRevision: "7",
      previousSequence: 0,
      boundaryAt: null,
      termsDigest: "b".repeat(64),
    };
    expect(
      standaloneIssuanceConfirmSchema.parse({
        requestId: randomUUID(),
        graceDays: null,
        offline: null,
        expected,
      }),
    ).toMatchObject({ graceDays: null, offline: null, expected });
    for (const invalid of [
      { requestId: randomUUID(), graceDays: null, offline: null },
      { requestId: randomUUID(), graceDays: null, expected },
      { requestId: randomUUID(), graceDays: 61, offline: null, expected },
      { requestId: randomUUID(), graceDays: -1, offline: null, expected },
      { requestId: "not-a-uuid", graceDays: 0, offline: null, expected },
      {
        requestId: randomUUID(),
        graceDays: null,
        offline: null,
        expected: { ...expected, termsDigest: "B".repeat(64) },
      },
      {
        requestId: randomUUID(),
        graceDays: null,
        offline: null,
        expected: { entitlementRevision: "7", previousSequence: 0, boundaryAt: null },
      },
    ]) {
      expect(standaloneIssuanceConfirmSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("captures offline terms as a catalog plan version and a term of 1 to 365 days, never unlimited", () => {
    const planVersionId = randomUUID();
    expect(
      standaloneIssuancePreviewRequestSchema.parse({
        graceDays: null,
        offline: { planVersionId, termDays: 365 },
      }),
    ).toEqual({ graceDays: null, offline: { planVersionId, termDays: 365 } });
    for (const offline of [
      { planVersionId, termDays: 0 },
      { planVersionId, termDays: 366 },
      { planVersionId, termDays: null },
      { planVersionId },
      { planVersionId, termDays: 1.5 },
      { planVersionId: "plan", termDays: 30 },
      { planVersionId, termDays: 30, quotas: { stations: 9 } },
    ]) {
      expect(
        standaloneIssuancePreviewRequestSchema.safeParse({ graceDays: null, offline }).success,
      ).toBe(false);
    }
  });

  it("marks every issuance with its source and ties offline files to the offline term reason", () => {
    const summary = {
      licenseId: randomUUID(),
      siteId: randomUUID(),
      sequence: 1,
      hostId: request.hostId,
      source: "offline",
      plan: "subscription",
      planVersionId: randomUUID(),
      entitlementRevision: "0",
      validFrom: "2026-10-13T00:00:00.000Z",
      validUntil: "2027-10-13T00:00:00.000Z",
      validUntilReason: "offline_term",
      graceDays: 14,
      kid: "lic-1",
      sha256: "a".repeat(64),
      issuedAt: "2026-10-13T00:00:00.000Z",
      issuedByPlatformUserId: "admin",
      replaces: null,
      sourceAssignments: null,
      customer: { name: "ООО «Завод»", inn: "7707083893" },
      rights: {
        quotas: { lines: null, stations: 3, kiosks: 0, cabinetUsers: 5 },
        features: {
          labelEditor: true,
          publicApi: false,
          pallets: true,
          chzIntegration: false,
          inventory: false,
          commerceMl: false,
          handheld: true,
          customLogo: false,
        },
      },
    };
    expect(standaloneIssuanceSummarySchema.parse(summary).source).toBe("offline");
    for (const invalid of [
      { ...summary, validUntilReason: "subscription_end" },
      { ...summary, source: "subscription" },
      { ...summary, plan: "demo", graceDays: 0 },
      { ...summary, source: "cloud" },
    ]) {
      expect(standaloneIssuanceSummarySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("knows the four sources and ties each to its term reasons and assignments", () => {
    expect([...STANDALONE_ISSUANCE_SOURCES]).toEqual([
      "subscription",
      "offline",
      "offline_assignments",
      "offline_demo",
    ]);
    const base = {
      licenseId: randomUUID(),
      siteId: randomUUID(),
      sequence: 1,
      hostId: request.hostId,
      plan: "subscription",
      planVersionId: randomUUID(),
      entitlementRevision: "5",
      validFrom: "2026-10-13T00:00:00.000Z",
      validUntil: "2027-10-13T00:00:00.000Z",
      graceDays: 14,
      kid: "lic-1",
      sha256: "a".repeat(64),
      issuedAt: "2026-10-13T00:00:00.000Z",
      issuedByPlatformUserId: "admin",
      replaces: null,
      customer: { name: "ООО «Завод»", inn: "7707083893" },
      rights: {
        quotas: { lines: null, stations: 3, kiosks: 0, cabinetUsers: 5 },
        features: {
          labelEditor: true,
          publicApi: false,
          pallets: true,
          chzIntegration: false,
          inventory: false,
          commerceMl: false,
          handheld: true,
          customLogo: false,
        },
      },
    };
    const refs = [{ kind: "plan", id: randomUUID(), catalogVersionId: randomUUID() }];
    const ok = (source: string, validUntilReason: string, sourceAssignments: unknown) =>
      standaloneIssuanceSummarySchema.safeParse({
        ...base,
        source,
        validUntilReason,
        sourceAssignments,
      }).success;
    expect(ok("offline", "offline_term", null)).toBe(true);
    expect(ok("offline_assignments", "one_year_cap", refs)).toBe(true);
    expect(ok("offline_assignments", "offline_term", refs)).toBe(false);
    expect(ok("offline_assignments", "one_year_cap", null)).toBe(false);
    expect(ok("offline_assignments", "one_year_cap", [])).toBe(false);
    expect(ok("subscription", "one_year_cap", null)).toBe(true);
    expect(ok("subscription", "one_year_cap", refs)).toBe(false);
    expect(ok("subscription", "offline_term", null)).toBe(false);
    expect(ok("offline", "offline_term", refs)).toBe(false);
    // The demo term reason belongs to the offline demo only.
    expect(ok("subscription", "demo_term", null)).toBe(false);
    expect(ok("offline_assignments", "demo_term", refs)).toBe(false);
  });

  it("bounds the file to 16 KiB and the canonical file name", () => {
    const shape = standaloneLicenseFileSchema.shape;
    expect(shape.compact.safeParse("a".repeat(16_384)).success).toBe(true);
    expect(shape.compact.safeParse("a".repeat(16_385)).success).toBe(false);
    expect(shape.fileName.safeParse("markiro-3f1c2d4e-001.mklic").success).toBe(true);
    expect(shape.fileName.safeParse("../markiro-3f1c2d4e-001.mklic").success).toBe(false);
  });

  it("describes each issuance warning by code with its own facts", () => {
    expect(
      standaloneIssuanceWarningSchema.parse({
        code: "quota_below_usage",
        quota: "stations",
        limit: 2,
        used: 4,
      }),
    ).toEqual({ code: "quota_below_usage", quota: "stations", limit: 2, used: 4 });
    expect(
      standaloneIssuanceWarningSchema.safeParse({ code: "feature_unmapped", feature: "lines" })
        .success,
    ).toBe(false);
  });

  it("publishes every route under the tenant's standalone sites", () => {
    expect(
      Object.values(platformStandaloneLicenseContracts).map(
        ({ method, path }) => `${method} ${path}`,
      ),
    ).toEqual([
      "GET /platform/tenants/:tenantId/standalone-sites",
      "POST /platform/tenants/:tenantId/standalone-sites/inspect",
      "POST /platform/tenants/:tenantId/standalone-sites",
      "POST /platform/tenants/:tenantId/standalone-sites/:siteId/issuances/preview",
      "POST /platform/tenants/:tenantId/standalone-sites/:siteId/issuances",
      "GET /platform/tenants/:tenantId/standalone-sites/:siteId/issuances",
      "GET /platform/tenants/:tenantId/standalone-sites/:siteId/issuances/:licenseId/file",
    ]);
  });
});

describe("the issuance journal's assignment bound", () => {
  const ref = () => ({
    kind: "addon" as const,
    id: randomUUID(),
    catalogVersionId: randomUUID(),
  });

  it("accepts a plan with 64 add-ons (65 references) and rejects 66 or none", () => {
    expect(STANDALONE_ASSIGNMENT_REFS_MAX).toBe(65);
    expect(standaloneAssignmentRefsSchema.safeParse(Array.from({ length: 65 }, ref)).success).toBe(
      true,
    );
    expect(standaloneAssignmentRefsSchema.safeParse(Array.from({ length: 66 }, ref)).success).toBe(
      false,
    );
    expect(standaloneAssignmentRefsSchema.safeParse([]).success).toBe(false);
  });

  it("is the bound the database enforces, so the contract and the constraint cannot drift", () => {
    const sql = readFileSync(
      new URL("../../db/migrations/0195_offline_catalog_items.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain(
      `jsonb_array_length("standalone_license_issuances"."source_assignments") between 1 and ${STANDALONE_ASSIGNMENT_REFS_MAX}`,
    );
  });
});

describe("activation exports with usage statistics", () => {
  it("accepts legacy requests and an opaque token without changing the host request", () => {
    expect(standaloneActivationExportSchema.parse(request)).toEqual(request);
    const exported = { ...request, supportToken: "MKS1.test.ABC_-12" };
    expect(standaloneActivationExportSchema.parse(exported)).toEqual(exported);
    expect(standaloneActivationRequestSchema.safeParse(exported).success).toBe(false);
    expect(
      platformStandaloneLicenseContracts.inspect.body.parse({ request: exported }).request,
    ).toEqual(exported);
    for (const supportToken of ["plaintext counts", "MKS1.test." + "a".repeat(16384)])
      expect(standaloneActivationExportSchema.safeParse({ ...request, supportToken }).success).toBe(
        false,
      );
  });
});

describe("the offline demo file of a tenant without a cabinet (spec 2026-10-20 §4.2)", () => {
  const summary = {
    licenseId: randomUUID(),
    siteId: randomUUID(),
    sequence: 2,
    hostId: request.hostId,
    source: "offline_demo",
    plan: "demo",
    planVersionId: STANDALONE_DEMO_PLAN_VERSION_ID,
    entitlementRevision: "0",
    validFrom: "2026-10-21T00:00:00.000Z",
    validUntil: "2026-11-04T00:00:00.000Z",
    validUntilReason: "demo_term",
    graceDays: 0,
    kid: "lic-1",
    sha256: "a".repeat(64),
    issuedAt: "2026-10-21T00:00:00.000Z",
    issuedByPlatformUserId: "admin",
    replaces: null,
    sourceAssignments: null,
    customer: { name: "ООО «Завод»", inn: "7707083893" },
    rights: {
      quotas: { lines: null, stations: null, kiosks: null, cabinetUsers: null },
      features: {
        labelEditor: true,
        publicApi: true,
        pallets: true,
        chzIntegration: true,
        inventory: true,
        commerceMl: true,
        handheld: true,
        customLogo: true,
      },
    },
  };
  const refs = [{ kind: "plan", id: randomUUID(), catalogVersionId: randomUUID() }];

  it("takes a term of 1 to 45 whole days and nothing else", () => {
    expect(STANDALONE_DEMO_TERM_MAX_DAYS).toBe(45);
    for (const termDays of [1, 14, 45])
      expect(standaloneDemoTermsSchema.parse({ termDays })).toEqual({ termDays });
    for (const invalid of [
      { termDays: 0 },
      { termDays: 46 },
      { termDays: 1.5 },
      { termDays: -1 },
      { termDays: "14" },
      {},
      { termDays: 14, planVersionId: randomUUID() },
    ])
      expect(standaloneDemoTermsSchema.safeParse(invalid).success).toBe(false);
  });

  it("carries the demo term in the preview and the confirmation; an old client sends none", () => {
    const expected = {
      entitlementRevision: "0",
      previousSequence: 0,
      boundaryAt: null,
      termsDigest: "b".repeat(64),
    };
    expect(
      standaloneIssuancePreviewRequestSchema.parse({
        graceDays: null,
        offline: null,
        demo: { termDays: 14 },
      }).demo,
    ).toEqual({ termDays: 14 });
    expect(
      standaloneIssuancePreviewRequestSchema.parse({ graceDays: null, offline: null }).demo,
    ).toBeUndefined();
    expect(
      standaloneIssuanceConfirmSchema.parse({
        requestId: randomUUID(),
        graceDays: null,
        offline: null,
        demo: { termDays: 45 },
        expected,
      }).demo,
    ).toEqual({ termDays: 45 });
    expect(
      standaloneIssuancePreviewRequestSchema.safeParse({
        graceDays: null,
        offline: null,
        demo: { termDays: 46 },
      }).success,
    ).toBe(false);
    expect(
      standaloneIssuanceConfirmSchema.safeParse({
        requestId: randomUUID(),
        graceDays: null,
        offline: null,
        demo: { termDays: 0 },
        expected,
      }).success,
    ).toBe(false);
  });

  it("is a demo plan with no grace under the demo term, with or without named assignments", () => {
    expect(standaloneIssuanceSummarySchema.parse(summary).source).toBe("offline_demo");
    expect(
      standaloneIssuanceSummarySchema.safeParse({ ...summary, sourceAssignments: refs }).success,
    ).toBe(true);
    for (const invalid of [
      { ...summary, plan: "subscription" },
      { ...summary, graceDays: 14 },
      { ...summary, validUntilReason: "one_year_cap" },
      { ...summary, validUntilReason: "offline_term" },
      { ...summary, sourceAssignments: [] },
    ])
      expect(standaloneIssuanceSummarySchema.safeParse(invalid).success).toBe(false);
    const next = Object.fromEntries(
      Object.entries(summary).filter(
        ([key]) =>
          !["licenseId", "siteId", "hostId", "kid", "sha256", "issuedAt"].includes(key) &&
          !["issuedByPlatformUserId", "replaces"].includes(key),
      ),
    );
    const shape = standaloneIssuancePreviewSchema.shape.next;
    expect(shape.safeParse(next).success).toBe(true);
    expect(shape.safeParse({ ...next, graceDays: 3 }).success).toBe(false);
  });

  it("is the term bound the database enforces, so the contract and the constraint cannot drift", () => {
    const sql = readFileSync(
      new URL("../../db/migrations/0198_standalone_offline_demo.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain(
      `"standalone_license_issuances"."valid_from" <= interval '${STANDALONE_DEMO_TERM_MAX_DAYS} days'`,
    );
  });

  it("signs a plan version id the host accepts when no tariff is assigned", () => {
    // markiro_proto::trust::is_uuid: a version nibble 1-8 and an RFC variant.
    expect(STANDALONE_DEMO_PLAN_VERSION_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

describe("the landing lead of a standalone site (spec 2026-10-20 §15.6)", () => {
  const site = {
    id: randomUUID(),
    tenantId: "tenant-1",
    hostId: request.hostId,
    name: "Цех",
    requestInn: "7707083893",
    hostVersion: null,
    usage: null,
    requestCreatedAt: null,
    hostHistory: [
      {
        hostId: request.hostId,
        requestInn: "7707083893",
        requestId: randomUUID(),
        boundAt: "2026-10-21T00:00:00.000Z",
        boundByPlatformUserId: "admin",
      },
    ],
    lastIssuedSequence: 0,
    latestIssuance: null,
    renewalDue: false,
    createdAt: "2026-10-21T00:00:00.000Z",
  };

  it("names the matching leads by id only: linked, unresolved or none; no INN, no match", () => {
    const leadId = randomUUID();
    for (const leadLink of [
      { state: "linked", leadIds: [leadId] },
      { state: "unresolved", leadIds: [leadId, randomUUID()] },
      { state: "none", leadIds: [] },
      null,
    ])
      expect(standaloneSiteSchema.parse({ ...site, leadLink }).leadLink).toEqual(leadLink);
    for (const leadLink of [
      { state: "linked", leadIds: [] },
      { state: "unresolved", leadIds: [] },
      { state: "none", leadIds: [leadId] },
      { state: "linked", leadIds: [leadId], email: "a@example.invalid" },
      { state: "maybe", leadIds: [leadId] },
    ])
      expect(standaloneSiteSchema.safeParse({ ...site, leadLink }).success).toBe(false);
  });
});
