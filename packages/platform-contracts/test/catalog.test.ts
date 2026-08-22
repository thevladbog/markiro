import { describe, expect, it } from "vitest";

import {
  catalogVersionCreateSchema,
  catalogVersionPatchSchema,
  platformCatalogContracts,
} from "../src/index.js";

const PLAN_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const ADDON_VERSION_ID = "21111111-1111-4111-8111-111111111111";
const SERVICE_VERSION_ID = "31111111-1111-4111-8111-111111111111";

const planCreate = {
  nameRu: "Базовый",
  nameEn: "Basic",
  descriptionRu: null,
  descriptionEn: "For one site",
  unit: "month",
  billingMode: "recurring",
  billingPeriod: "month",
  unitPrice: "15000.00",
  vatRateBps: 2000,
  vatIncluded: true,
  plan: {
    maxLines: 2,
    maxStations: 3,
    maxKiosks: 1,
    maxCabinetUsers: null,
    labelEditorEnabled: true,
    publicApiEnabled: false,
    palletsEnabled: false,
    demoDurationDays: 14,
  },
} as const;

const responseBase = {
  catalogItemId: "41111111-1111-4111-8111-111111111111",
  catalogItemCode: "plan-basic",
  version: 1,
  nameRu: "Базовый",
  nameEn: "Basic",
  descriptionRu: null,
  descriptionEn: "For one site",
  unit: "month",
  billingMode: "recurring",
  billingPeriod: "month",
  unitPrice: "15000.00",
  vatRateBps: 2000,
  vatIncluded: true,
  publishedByPlatformUserId: null,
} as const;

describe("platform catalog contracts", () => {
  it("parses plan creates with financial terms, nullable quotas, and the int4 limit", () => {
    expect(catalogVersionCreateSchema.parse(planCreate)).toEqual(planCreate);
    expect(
      catalogVersionCreateSchema.parse({
        ...planCreate,
        plan: { ...planCreate.plan, maxLines: 2_147_483_647 },
      }),
    ).toMatchObject({ plan: { maxLines: 2_147_483_647, maxCabinetUsers: null } });

    for (const maxLines of [0, 2_147_483_648]) {
      expect(
        catalogVersionCreateSchema.safeParse({
          ...planCreate,
          plan: { ...planCreate.plan, maxLines },
        }).success,
      ).toBe(false);
    }
    expect(
      catalogVersionCreateSchema.safeParse({ ...planCreate, billingMode: "one_time" }).success,
    ).toBe(false);
  });

  it("parses add-on quota and feature effects while rejecting duplicates and wrong shapes", () => {
    const { plan: _plan, ...recurringFields } = planCreate;
    void _plan;
    const addon = {
      ...recurringFields,
      addon: {
        effects: [
          { key: "stations", quotaIncrement: 2 },
          { key: "publicApi", featureEnabled: true },
        ],
      },
    } as const;

    const parsed = catalogVersionCreateSchema.parse(addon);
    expect("addon" in parsed ? parsed.addon.effects : []).toEqual(addon.addon.effects);
    expect(
      catalogVersionCreateSchema.safeParse({
        ...addon,
        addon: {
          effects: [
            { key: "stations", quotaIncrement: 1 },
            { key: "stations", quotaIncrement: 2 },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      catalogVersionCreateSchema.safeParse({
        ...addon,
        addon: { effects: [{ key: "publicApi", featureEnabled: false }] },
      }).success,
    ).toBe(false);
  });

  it("keeps one-time service billingPeriod null or omitted and rejects recurring services", () => {
    const { plan: _plan, ...commonFields } = planCreate;
    void _plan;
    const service = {
      ...commonFields,
      billingMode: "one_time",
      billingPeriod: null,
      service: {},
    } as const;
    expect(catalogVersionCreateSchema.parse(service)).toEqual(service);

    const { billingPeriod: _billingPeriod, ...withoutBillingPeriod } = service;
    void _billingPeriod;
    const parsedWithoutPeriod = catalogVersionCreateSchema.parse(withoutBillingPeriod);
    expect(parsedWithoutPeriod).not.toHaveProperty("billingPeriod");
    expect(
      catalogVersionCreateSchema.safeParse({
        ...service,
        billingMode: "recurring",
        billingPeriod: "month",
      }).success,
    ).toBe(false);
  });

  it("preserves patch nulls and distinguishes them from omitted fields", () => {
    const parsed = catalogVersionPatchSchema.parse({
      descriptionRu: null,
      vatRateBps: null,
      billingPeriod: null,
    });

    expect(parsed).toEqual({ descriptionRu: null, vatRateBps: null, billingPeriod: null });
    expect(parsed).not.toHaveProperty("unitPrice");
    expect(
      catalogVersionPatchSchema.safeParse({ plan: planCreate.plan, service: {} }).success,
    ).toBe(false);
  });

  it("parses discriminated plan, add-on, and service responses across status transitions", () => {
    const parsed = platformCatalogContracts.list.response.parse({
      items: [
        {
          ...responseBase,
          id: PLAN_VERSION_ID,
          kind: "plan",
          status: "draft",
          publishedAt: null,
          plan: planCreate.plan,
        },
        {
          ...responseBase,
          id: ADDON_VERSION_ID,
          catalogItemCode: "addon-stations",
          kind: "addon",
          status: "published",
          publishedAt: "2026-08-11 18:08:42.158+00",
          addon: { effects: [{ key: "stations", quotaIncrement: 2 }] },
        },
        {
          ...responseBase,
          id: SERVICE_VERSION_ID,
          catalogItemCode: "service-launch",
          kind: "service",
          status: "retired",
          billingMode: "one_time",
          billingPeriod: null,
          publishedAt: new Date("2026-08-12T10:00:00.000Z"),
          service: {},
        },
      ],
    });

    expect(parsed.items.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: "plan", status: "draft" },
      { kind: "addon", status: "published" },
      { kind: "service", status: "retired" },
    ]);
    expect(parsed.items[1]?.publishedAt).toBe("2026-08-11T18:08:42.158Z");
    expect(parsed.items[2]?.publishedAt).toBe("2026-08-12T10:00:00.000Z");
  });

  it("requires the endpoint-specific status after catalog transitions", () => {
    const draftPlan = {
      ...responseBase,
      id: PLAN_VERSION_ID,
      kind: "plan",
      status: "draft",
      publishedAt: null,
      plan: planCreate.plan,
    } as const;

    expect(platformCatalogContracts.createVersion.response.safeParse(draftPlan).success).toBe(true);
    expect(platformCatalogContracts.updateVersion.response.safeParse(draftPlan).success).toBe(true);
    expect(
      platformCatalogContracts.createVersion.response.safeParse({
        ...draftPlan,
        status: "published",
      }).success,
    ).toBe(false);
    expect(
      platformCatalogContracts.updateVersion.response.safeParse({
        ...draftPlan,
        status: "retired",
      }).success,
    ).toBe(false);
    expect(
      platformCatalogContracts.publishVersion.response.safeParse({
        ...draftPlan,
        status: "published",
        publishedAt: "2026-08-22T10:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(platformCatalogContracts.publishVersion.response.safeParse(draftPlan).success).toBe(
      false,
    );
    expect(
      platformCatalogContracts.retireVersion.response.safeParse({
        ...draftPlan,
        status: "retired",
      }).success,
    ).toBe(true);
    expect(
      platformCatalogContracts.retireVersion.response.safeParse({
        ...draftPlan,
        status: "published",
      }).success,
    ).toBe(false);
  });

  it("rejects response effects that do not match the discriminated catalog kind", () => {
    expect(
      platformCatalogContracts.getVersion.response.safeParse({
        ...responseBase,
        id: PLAN_VERSION_ID,
        kind: "plan",
        status: "draft",
        publishedAt: null,
        addon: { effects: [{ key: "stations", quotaIncrement: 1 }] },
      }).success,
    ).toBe(false);
    expect(
      platformCatalogContracts.getVersion.response.safeParse({
        ...responseBase,
        id: PLAN_VERSION_ID,
        kind: "plan",
        status: "active",
        publishedAt: null,
        plan: planCreate.plan,
      }).success,
    ).toBe(false);
  });

  it("keeps support financial fields omitted while preserving nullable response fields", () => {
    const {
      unitPrice: _unitPrice,
      vatRateBps: _vatRateBps,
      vatIncluded: _vatIncluded,
      ...redacted
    } = responseBase;
    void _unitPrice;
    void _vatRateBps;
    void _vatIncluded;
    const parsed = platformCatalogContracts.getVersion.response.parse({
      ...redacted,
      id: PLAN_VERSION_ID,
      kind: "plan",
      status: "draft",
      publishedAt: null,
      plan: planCreate.plan,
    });

    expect(parsed.descriptionRu).toBeNull();
    expect(parsed.publishedAt).toBeNull();
    expect(parsed).not.toHaveProperty("unitPrice");
    expect(parsed).not.toHaveProperty("vatRateBps");
    expect(parsed).not.toHaveProperty("vatIncluded");
  });

  it("rejects partial financial disclosure in catalog responses", () => {
    const planResponse = {
      ...responseBase,
      id: PLAN_VERSION_ID,
      kind: "plan",
      status: "published",
      publishedAt: "2026-08-22T10:00:00.000Z",
      plan: planCreate.plan,
    } as const;

    const { vatRateBps: _vatRateBps, ...withoutVatRate } = planResponse;
    void _vatRateBps;
    expect(platformCatalogContracts.getVersion.response.safeParse(withoutVatRate).success).toBe(
      false,
    );

    const { vatIncluded: _vatIncluded, ...withoutVatIncluded } = planResponse;
    void _vatIncluded;
    expect(platformCatalogContracts.getVersion.response.safeParse(withoutVatIncluded).success).toBe(
      false,
    );

    const { unitPrice: _unitPrice, ...withoutUnitPrice } = planResponse;
    void _unitPrice;
    expect(platformCatalogContracts.getVersion.response.safeParse(withoutUnitPrice).success).toBe(
      false,
    );
  });

  it("rejects nested fields on the empty service response payload", () => {
    expect(
      platformCatalogContracts.getVersion.response.safeParse({
        ...responseBase,
        id: SERVICE_VERSION_ID,
        catalogItemCode: "service-launch",
        kind: "service",
        status: "published",
        billingMode: "one_time",
        billingPeriod: null,
        publishedAt: "2026-08-22T10:00:00.000Z",
        service: { effects: [{ key: "stations", quotaIncrement: 1 }] },
      }).success,
    ).toBe(false);
  });

  it("parses nullable demo-plan reads and non-null writes", () => {
    expect(
      platformCatalogContracts.getDefaultDemo.response.parse({ catalogVersionId: null }),
    ).toEqual({ catalogVersionId: null });
    expect(
      platformCatalogContracts.setDefaultDemo.body.parse({ catalogVersionId: PLAN_VERSION_ID }),
    ).toEqual({ catalogVersionId: PLAN_VERSION_ID });
    expect(
      platformCatalogContracts.setDefaultDemo.response.parse({ catalogVersionId: PLAN_VERSION_ID }),
    ).toEqual({ catalogVersionId: PLAN_VERSION_ID });
    expect(
      platformCatalogContracts.setDefaultDemo.body.safeParse({ catalogVersionId: null }).success,
    ).toBe(false);
  });
});
