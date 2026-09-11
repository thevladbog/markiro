import { describe, expect, it } from "vitest";
import { resolveCommercialPeriod } from "@markiro/domain";
import * as contracts from "../src/index.js";

const plan = {
  maxLines: null,
  maxStations: 1,
  maxKiosks: 0,
  maxCabinetUsers: 2,
  labelEditorEnabled: true,
  publicApiEnabled: false,
  palletsEnabled: false,
  demoDurationDays: 14,
};
const fields = {
  nameRu: "Тариф",
  nameEn: "Plan",
  unit: "month",
  unitPrice: "100.00",
  vatIncluded: false,
  billingMode: "recurring",
  billingPeriod: "month",
  plan,
};
const metadata = {
  documentNameRu: "Право использования Маркиро",
  documentNameEn: null,
  subject: "software_license",
  sellerPolicyRevision: 1,
};
const terms = {
  version: 1,
  ...metadata,
  billingPeriod: "month",
  billingTimezone: "Europe/Moscow",
  activationRule: "on_application",
};

describe("commercial V2 boundaries", () => {
  it("distinguishes zero/null resources from positive trial and increments", () => {
    expect(contracts.planEntitlementsSchema.safeParse(plan).success).toBe(true);
    for (const value of [-1, 0.1, 2_147_483_648])
      expect(
        contracts.planEntitlementsSchema.safeParse({ ...plan, maxKiosks: value }).success,
      ).toBe(false);
    expect(
      contracts.planEntitlementsSchema.safeParse({ ...plan, demoDurationDays: 0 }).success,
    ).toBe(false);
    expect(
      contracts.addonEffectSchema.safeParse({ key: "kiosks", quotaIncrement: 0 }).success,
    ).toBe(false);
  });
  it("preserves complete strict legacy requests and negotiates complete V2 requests", () => {
    const legacy = { ...fields, plan: { ...plan, maxKiosks: null } };
    expect(contracts.legacyCatalogVersionCreateSchema.parse(legacy)).toEqual(legacy);
    expect(
      contracts.legacyCatalogVersionCreateSchema.safeParse({ ...legacy, ...metadata }).success,
    ).toBe(false);
    expect(contracts.legacyCatalogVersionCreateSchema.safeParse(fields).success).toBe(false);
    expect(contracts.catalogVersionCreateV2Schema.parse({ ...fields, ...metadata })).toEqual({
      ...fields,
      ...metadata,
    });
    expect(
      contracts.catalogVersionCreateV2Schema.safeParse({
        ...fields,
        ...metadata,
        subject: "service",
      }).success,
    ).toBe(false);
    expect(
      contracts.catalogVersionCreateV2Schema.safeParse({
        ...fields,
        ...metadata,
        billingPeriod: null,
      }).success,
    ).toBe(false);
  });
  it("requires complete nullable response metadata only in V2", () => {
    const response = {
      ...fields,
      plan: { ...plan, maxKiosks: null },
      id: "11111111-1111-4111-8111-111111111111",
      catalogItemId: "21111111-1111-4111-8111-111111111111",
      catalogItemCode: "basic",
      kind: "plan",
      version: 1,
      status: "draft",
      descriptionRu: null,
      descriptionEn: null,
      vatRateBps: null,
      publishedAt: null,
      publishedByPlatformUserId: null,
    };
    expect(contracts.legacyCatalogVersionSchema.parse(response)).toEqual(response);
    expect(
      contracts.legacyCatalogVersionSchema.safeParse({ ...response, ...metadata }).success,
    ).toBe(false);
    expect(contracts.catalogVersionV2Schema.parse({ ...response, ...metadata, plan })).toEqual({
      ...response,
      ...metadata,
      plan,
    });
    expect(contracts.catalogVersionV2Schema.safeParse(response).success).toBe(false);
  });
  it("validates explicit seller tax choices", () => {
    expect(contracts.sellerTaxPolicySchema.parse({ kind: "without_vat", regime: "npd" })).toEqual({
      kind: "without_vat",
      regime: "npd",
    });
    const policy = {
      kind: "vat",
      regime: "other",
      allowedRatesBps: [0, 2000],
      defaultRateBps: 2000,
      defaultIncluded: true,
    };
    expect(contracts.sellerTaxPolicySchema.parse(policy)).toEqual(policy);
    for (const invalid of [
      { ...policy, regime: "npd" },
      { ...policy, allowedRatesBps: [2000, 2000] },
      { ...policy, defaultRateBps: 1000 },
      { ...policy, allowedRatesBps: [] },
      { ...policy, extra: true },
    ])
      expect(contracts.sellerTaxPolicySchema.safeParse(invalid).success).toBe(false);
  });
  it("validates immutable line terms and calendar boundaries", () => {
    expect(contracts.commercialLineTermsSchema.parse(terms)).toEqual(terms);
    for (const invalid of [
      { ...terms, version: 2 },
      { ...terms, subject: "service" },
      { ...terms, billingPeriod: null },
      { ...terms, sellerPolicyRevision: 0 },
    ])
      expect(contracts.commercialLineTermsSchema.safeParse(invalid).success).toBe(false);
    const period = resolveCommercialPeriod({
      anchorAt: "2026-01-31T09:00:00Z",
      billingPeriod: "month",
      cycle: 1,
    });
    expect(contracts.commercialPeriodSchema.parse(period)).toEqual(period);
    expect(
      contracts.commercialPeriodSchema.safeParse({ ...period, endsAt: "2026-03-28T09:00:00Z" })
        .success,
    ).toBe(false);
  });
});

it("rejects inconsistent partial catalog terms and duplicate response effects", () => {
  expect(
    contracts.catalogVersionPatchV2Schema.safeParse({ plan, billingMode: "one_time" }).success,
  ).toBe(false);
  expect(
    contracts.catalogVersionPatchV2Schema.safeParse({ service: {}, billingPeriod: "month" })
      .success,
  ).toBe(false);
  const { plan: _plan, ...base } = fields;
  void _plan;
  expect(
    contracts.catalogVersionCreateV2Schema.safeParse({
      ...base,
      ...metadata,
      addon: {
        effects: [
          { key: "kiosks", quotaIncrement: 1 },
          { key: "kiosks", quotaIncrement: 2 },
        ],
      },
    }).success,
  ).toBe(false);
});

it("requires one plan in V2 drafts before server-resolved terms exist", () => {
  const line = {
    kind: "plan",
    catalogVersionId: "11111111-1111-4111-8111-111111111111",
    nameRu: "Тариф",
    nameEn: "Plan",
    quantity: 2,
    unit: "year",
    agreedUnitPrice: "100.00",
    vatIncluded: false,
  };
  expect(contracts.offerCreateLineV2Schema.safeParse(line).success).toBe(false);
  expect(contracts.invoiceCreateLineV2Schema.safeParse(line).success).toBe(false);
  expect(contracts.invoiceCreateLineV2Schema.safeParse({ ...line, kind: "addon" }).success).toBe(
    true,
  );
});
it("negotiates explicit seller tax policy without changing the legacy profile input", () => {
  const profile = {
    kind: "self_employed",
    inn: "123456789012",
    fullName: "Иванов Иван Иванович",
    displayName: "Иванов",
    legalAddressRaw: "Москва",
    actualAddress: { sameAsLegal: true },
    postalAddress: { sameAsLegal: true },
    contact: { name: null, email: null, phone: null },
  };
  const current = { ...profile, taxPolicy: { kind: "without_vat", regime: "npd" } };
  expect(contracts.legacyOperatorBillingProfileInputSchema.parse(profile)).toEqual(profile);
  expect(contracts.legacyOperatorBillingProfileInputSchema.safeParse(current).success).toBe(false);
  expect(contracts.operatorBillingProfileInputV2Schema.parse(current)).toEqual(current);
  expect(contracts.operatorBillingProfileInputV2Schema.parse(profile)).toEqual(profile);
});

it("uses V2 request terms and plan quantity in the exported billing-request offer map", () => {
  const body = contracts.platformCommercialV2Contracts.billingRequests.createOffer.body;
  const line = {
    kind: "plan",
    catalogVersionId: "11111111-1111-4111-8111-111111111111",
    nameRu: "Тариф",
    nameEn: "Plan",
    quantity: 1,
    unit: "month",
    agreedUnitPrice: "100.00",
    vatIncluded: false,
  };
  const request = { idempotencyKey: "21111111-1111-4111-8111-111111111111", lines: [line] };
  expect(body.safeParse({ ...request, lines: [{ ...line, quantity: 2 }] }).success).toBe(false);
  expect(body.parse({ ...request, lines: [{ ...line, commercialTerms: terms }] })).toEqual({
    ...request,
    lines: [{ ...line, commercialTerms: terms }],
  });
  const legacy = contracts.platformCommercialContracts.billingRequests.createOffer.body;
  expect(legacy.safeParse({ ...request, lines: [{ ...line, quantity: 2 }] }).success).toBe(true);
  expect(
    legacy.safeParse({ ...request, lines: [{ ...line, commercialTerms: terms }] }).success,
  ).toBe(false);
});

it.each([
  ["on_application", "on_application", false],
  ["after_current", "on_application", false],
  ["after_current", "after_current", false],
  ["on_application", "after_current", true],
] as const)("validates aggregate plan sequence %s then %s", (first, second, valid) => {
  const lines = [first, second].map((activationRule) => ({
    kind: "plan",
    catalogVersionId: "11111111-1111-4111-8111-111111111111",
    nameRu: "Тариф",
    nameEn: "Plan",
    quantity: 1,
    unit: "month",
    agreedUnitPrice: "100.00",
    vatIncluded: false,
    commercialTerms: { ...terms, activationRule },
  }));
  const tenantId = "21111111-1111-4111-8111-111111111111";
  expect(contracts.offerCreateV2Schema.safeParse({ tenantId, lines }).success).toBe(valid);
  expect(
    contracts.invoiceCreateV2Schema.safeParse({ tenantId, applicationMode: "manual", lines })
      .success,
  ).toBe(valid);
  expect(
    contracts.platformBillingRequestOfferCreateV2Schema.safeParse({
      idempotencyKey: tenantId,
      lines,
    }).success,
  ).toBe(valid);
  expect(
    contracts.offerCreateV2Schema.safeParse({ tenantId, lines: [...lines, lines[0]] }).success,
  ).toBe(false);
});
