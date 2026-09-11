import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const id = "11111111-1111-4111-8111-111111111111";
const p0 = {
  maxLines: null,
  maxStations: 1,
  maxKiosks: 0,
  maxCabinetUsers: 2,
  labelEditorEnabled: true,
  publicApiEnabled: false,
  palletsEnabled: false,
  demoDurationDays: 14,
};
const plan = {
  ...p0,
  chzIntegrationEnabled: false,
  inventoryEnabled: true,
  commerceMlEnabled: false,
  handheldEnabled: true,
};
const legacyPlan = {
  ...p0,
  chzIntegrationEnabled: null,
  inventoryEnabled: null,
  commerceMlEnabled: null,
  handheldEnabled: null,
};
const fields = {
  nameRu: "Тариф",
  nameEn: "Plan",
  unit: "month",
  unitPrice: "100.00",
  vatRateBps: null,
  vatIncluded: false,
  billingMode: "recurring",
  billingPeriod: "month",
};
const metadata = {
  documentNameRu: null,
  documentNameEn: null,
  subject: "software_license",
  sellerPolicyRevision: null,
};
const response = {
  ...fields,
  ...metadata,
  id,
  catalogItemId: id,
  catalogItemCode: "basic",
  kind: "plan",
  version: 1,
  status: "draft",
  descriptionRu: null,
  descriptionEn: null,
  publishedAt: null,
  publishedByPlatformUserId: null,
  plan,
  lifecyclePolicyId: null,
};
const effects = [
  { key: "lines", quotaIncrement: 1 },
  { key: "stations", quotaIncrement: 1 },
  { key: "kiosks", quotaIncrement: 1 },
  { key: "cabinetUsers", quotaIncrement: 1 },
  { key: "labelEditor", featureEnabled: true },
  { key: "publicApi", featureEnabled: true },
  { key: "pallets", featureEnabled: true },
  { key: "chzIntegration", featureEnabled: true },
  { key: "inventory", featureEnabled: true },
  { key: "commerceMl", featureEnabled: true },
  { key: "handheld", featureEnabled: true },
];

describe("strict negotiated commercial V3", () => {
  it("accepts eleven unique additive effects and rejects duplicates and malformed effects", () => {
    expect(c.addonPayloadV3Schema.parse({ effects })).toEqual({ effects });
    for (const invalid of [
      [...effects, effects[0]],
      [effects[0], effects[0]],
      [{ key: "handheld", featureEnabled: false }],
      [{ key: "inventory", quotaIncrement: 1 }],
    ])
      expect(c.addonPayloadV3Schema.safeParse({ effects: invalid }).success).toBe(false);
  });
  it("requires explicit P1 draft booleans and preserves strict V1/V2 requests", () => {
    expect(
      c.catalogVersionCreateV3Schema.parse({ ...fields, plan, lifecyclePolicyId: null }),
    ).toEqual({ ...fields, plan, lifecyclePolicyId: null });
    expect(
      c.catalogVersionCreateV3Schema.safeParse({ ...fields, plan: p0, lifecyclePolicyId: null })
        .success,
    ).toBe(false);
    expect(
      c.catalogVersionCreateV3Schema.safeParse({
        ...fields,
        plan: legacyPlan,
        lifecyclePolicyId: null,
      }).success,
    ).toBe(false);
    expect(c.planEntitlementsSchema.safeParse(plan).success).toBe(false);
    expect(c.catalogVersionCreateV2Schema.safeParse({ ...fields, plan }).success).toBe(false);
    expect(c.legacyCatalogVersionCreateSchema.safeParse({ ...fields, plan }).success).toBe(false);
    expect(c.catalogVersionPatchV3Schema.safeParse({ plan, billingMode: "one_time" }).success).toBe(
      false,
    );
    expect(c.catalogVersionPatchV3Schema.safeParse({ addon: { effects }, plan }).success).toBe(
      false,
    );
  });
  it("reads legacy nulls in V3 without losing nested effects or weakening V2", () => {
    expect(c.catalogVersionV3Schema.parse({ ...response, plan: legacyPlan })).toEqual({
      ...response,
      plan: legacyPlan,
    });
    expect(c.assignableCatalogVersionV3Schema.parse(response)).toEqual(response);
    const { plan: _plan, ...base } = response;
    void _plan;
    const addon = { ...base, kind: "addon", addon: { effects } };
    expect(c.platformCatalogV3Contracts.list.response.parse({ items: [addon] })).toEqual({
      items: [addon],
    });
    expect(c.assignableCatalogResponseV3Schema.parse({ items: [addon] })).toEqual({
      items: [addon],
    });
    expect(c.assignableCatalogVersionV2Schema.safeParse(addon).success).toBe(false);
    expect(c.catalogVersionV2Schema.safeParse(addon).success).toBe(false);
  });
  it("binds the V3 review to exact policy proof while keeping the editor policy list safe", () => {
    const identity = {
      catalogVersionId: id,
      draftUpdatedAt: "2026-09-11T00:00:00.000Z",
      sellerPolicyRevision: 1,
      lifecyclePolicyId: null,
      lifecyclePolicyVersion: null,
      lifecyclePolicyHash: null,
    };
    expect(
      c.platformCatalogV3Contracts.reviewVersion.response.parse({ identity, errors: [] }).identity,
    ).toEqual(identity);
    expect(c.platformCatalogV3Contracts.publishVersion.body.safeParse(identity).success).toBe(
      false,
    );
    expect(
      c.platformCatalogV2Contracts.reviewVersion.response.safeParse({ identity, errors: [] })
        .success,
    ).toBe(false);
    const context = {
      sellerPolicyRevision: 1,
      taxPolicy: null,
      taxDefaults: null,
      canWrite: true,
      lifecyclePolicies: [{ id, policyKey: "test", version: 1 }],
    };
    expect(c.catalogEditorContextV3Schema.parse(context)).toEqual(context);
    expect(c.platformCatalogV2Contracts.editorContext.response.safeParse(context).success).toBe(
      false,
    );
    expect(
      c.catalogEditorContextV3Schema.safeParse({
        ...context,
        lifecyclePolicies: [{ ...context.lifecyclePolicies[0], decisionReference: "private" }],
      }).success,
    ).toBe(false);
  });
  it("requires a lifecycle reference and explicit plan before V3 publication", () => {
    const body = {
      catalogVersionId: id,
      draftUpdatedAt: "2026-09-11T00:00:00.000Z",
      sellerPolicyRevision: 1,
      lifecyclePolicyId: id,
      lifecyclePolicyVersion: 1,
      lifecyclePolicyHash: "a".repeat(64),
    };
    expect(c.platformCatalogV3Contracts.publishVersion.body.parse(body)).toEqual(body);
    expect(
      c.platformCatalogV3Contracts.publishVersion.body.safeParse({
        ...body,
        lifecyclePolicyId: null,
      }).success,
    ).toBe(false);
    expect(
      c.platformCatalogV3Contracts.publishVersion.response.safeParse({
        ...response,
        status: "published",
      }).success,
    ).toBe(false);
    expect(
      c.platformCatalogV3Contracts.publishVersion.response.safeParse({
        ...response,
        status: "published",
        lifecyclePolicyId: id,
        plan: legacyPlan,
      }).success,
    ).toBe(false);
  });
  it("retains tenant nested V3 add-on and plan values", () => {
    const {
      plan: _plan,
      descriptionRu: _ru,
      descriptionEn: _en,
      publishedAt: _at,
      publishedByPlatformUserId: _by,
      ...base
    } = response;
    void _plan;
    void _ru;
    void _en;
    void _at;
    void _by;
    const subscription = {
      id,
      tenantId: "tenant-a",
      planVersionId: id,
      status: "active",
      startsAt: "2026-09-11T00:00:00.000Z",
      endsAt: null,
      source: "manual",
      createdByPlatformUserId: null,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
      commercialPeriod: null,
      planVersion: { ...base, entitlements: legacyPlan },
    };
    expect(c.tenantSubscriptionV3Schema.parse(subscription)).toEqual(subscription);
    const rowEffects = effects.map((effect) => ({
      entitlementKey: effect.key,
      quotaIncrement: "quotaIncrement" in effect ? effect.quotaIncrement : null,
      featureEnabled: "featureEnabled" in effect ? effect.featureEnabled : false,
    }));
    const addon = {
      id,
      subscriptionId: id,
      addonVersionId: id,
      quantity: 2,
      startsAt: subscription.startsAt,
      endsAt: null,
      status: "active",
      source: "manual",
      commercialPeriod: null,
      addonVersion: { ...base, kind: "addon", effects: rowEffects },
    };
    expect(c.tenantSubscriptionAddonV3Schema.parse(addon)).toEqual(addon);
    expect(
      c.tenantSubscriptionAddonV3Schema.safeParse({
        ...addon,
        addonVersion: { ...addon.addonVersion, effects: [...rowEffects, rowEffects[0]] },
      }).success,
    ).toBe(false);
  });
});

it.each([
  { patch: { billingMode: "one_time", billingPeriod: "month" }, valid: false },
  { patch: { billingMode: "recurring", billingPeriod: null }, valid: false },
  { patch: { subject: "software_license", billingMode: "one_time" }, valid: false },
  { patch: { subject: "software_license", billingPeriod: null }, valid: false },
  { patch: { subject: "service", billingMode: "recurring" }, valid: false },
  { patch: { subject: "development_work", billingPeriod: "year" }, valid: false },
  { patch: { service: {}, subject: "software_license" }, valid: false },
  { patch: { service: {}, billingMode: "recurring" }, valid: false },
  { patch: { service: {}, billingPeriod: "month" }, valid: false },
  {
    patch: { subject: "software_license", billingMode: "recurring", billingPeriod: "month" },
    valid: true,
  },
  {
    patch: { subject: "service", service: {}, billingMode: "one_time", billingPeriod: null },
    valid: true,
  },
  { patch: { subject: "development_work", service: {} }, valid: true },
  { patch: { subject: null }, valid: true },
  { patch: {}, valid: true },
])("preserves the same V2/V3 billing-subject decision for $patch", ({ patch, valid }) => {
  expect(c.catalogVersionPatchV2Schema.safeParse(patch).success).toBe(valid);
  expect(c.catalogVersionPatchV3Schema.safeParse(patch).success).toBe(valid);
});

it.each([
  { fields: { billingMode: "one_time" }, valid: false },
  { fields: { billingPeriod: null }, valid: false },
  { fields: { subject: "service" }, valid: false },
  { fields: { subject: "development_work" }, valid: false },
  { fields: { service: {} }, valid: false },
  {
    fields: { billingMode: "recurring", billingPeriod: "year", subject: "software_license" },
    valid: true,
  },
  { fields: { subject: null }, valid: true },
])("preserves V2/V3 plan and add-on consistency for $fields", ({ fields: patch, valid }) => {
  const addon = { effects: [{ key: "pallets", featureEnabled: true }] };
  expect(c.catalogVersionPatchV2Schema.safeParse({ plan: p0, ...patch }).success).toBe(valid);
  expect(c.catalogVersionPatchV3Schema.safeParse({ plan, ...patch }).success).toBe(valid);
  expect(c.catalogVersionPatchV2Schema.safeParse({ addon, ...patch }).success).toBe(valid);
  expect(c.catalogVersionPatchV3Schema.safeParse({ addon, ...patch }).success).toBe(valid);
});
