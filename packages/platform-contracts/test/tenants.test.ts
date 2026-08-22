import { describe, expect, it } from "vitest";
import { assignableCatalogResponseSchema, platformTenantContracts } from "../src/index.js";

const LEGACY_TENANT_ID = "legacy_better_auth_org";
const PLAN_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const ADDON_VERSION_ID = "21111111-1111-4111-8111-111111111111";
const SUBSCRIPTION_ID = "31111111-1111-4111-8111-111111111111";

const planVersion = {
  id: PLAN_VERSION_ID,
  catalogItemId: "41111111-1111-4111-8111-111111111111",
  catalogItemCode: "plan-demo",
  kind: "plan",
  version: 1,
  status: "published",
  nameRu: "Демо",
  nameEn: "Demo",
  unit: "month",
  billingMode: "recurring",
  billingPeriod: "month",
  unitPrice: "0.00",
  vatRateBps: null,
  vatIncluded: true,
  entitlements: {
    maxLines: 1,
    maxStations: null,
    maxKiosks: 1,
    maxCabinetUsers: 2,
    labelEditorEnabled: true,
    publicApiEnabled: false,
    palletsEnabled: false,
    demoDurationDays: 14,
  },
} as const;

describe("platform tenant contracts", () => {
  it("parses managed and unmanaged list rows with legacy ids and PostgreSQL timestamps", () => {
    const parsed = platformTenantContracts.list.response.parse({
      items: [
        {
          id: LEGACY_TENANT_ID,
          name: "Старое производство",
          slug: "legacy-factory",
          createdAt: "2026-08-11 18:08:42.158",
          subscriptionStatus: "unmanaged",
        },
        {
          id: "51111111-1111-4111-8111-111111111111",
          name: "Новая площадка",
          slug: "new-site",
          createdAt: "2026-08-12 10:00:00+00",
          subscriptionStatus: "pending_activation",
          subscription: {
            id: SUBSCRIPTION_ID,
            status: "pending_activation",
            startsAt: null,
            endsAt: null,
            planVersion: {
              id: PLAN_VERSION_ID,
              version: 1,
              nameRu: "Демо",
              nameEn: "Demo",
              unitPrice: "0.00",
            },
          },
        },
      ],
      page: 1,
      limit: 50,
      total: 2,
    });

    expect(parsed.items[0]).toMatchObject({
      id: LEGACY_TENANT_ID,
      createdAt: "2026-08-11T18:08:42.158Z",
      subscriptionStatus: "unmanaged",
    });
    expect(parsed.items[0]).not.toHaveProperty("subscription");
    expect(parsed.items[1]?.subscription).toMatchObject({ startsAt: null, endsAt: null });
  });

  it("parses tenant detail with nullable subscription and activation boundaries", () => {
    const parsed = platformTenantContracts.detail.response.parse({
      tenant: {
        id: LEGACY_TENANT_ID,
        name: "Старое производство",
        slug: "legacy-factory",
        createdAt: "2026-08-11 18:08:42.158",
      },
      subscriptionStatus: "pending_activation",
      ownerActivation: {
        ownerUserId: "legacy_owner",
        ownerEmail: "owner@example.com",
        emailVerified: false,
        deliveryId: null,
        status: "missing",
        createdAt: null,
        updatedAt: null,
        terminalAt: null,
      },
      currentSubscription: {
        id: SUBSCRIPTION_ID,
        tenantId: LEGACY_TENANT_ID,
        planVersionId: PLAN_VERSION_ID,
        status: "pending_activation",
        startsAt: null,
        endsAt: null,
        source: "demo",
        createdByPlatformUserId: null,
        createdAt: "2026-08-11 18:08:42.158",
        updatedAt: "2026-08-11 18:08:42.158+00",
        planVersion,
      },
      scheduledSubscription: null,
      activeAddons: [],
      scheduledAddons: [],
      usage: { cabinetUsers: 1, kiosks: 0, lines: 0, stations: 0 },
      events: [],
    });

    expect(parsed.tenant).toMatchObject({
      id: LEGACY_TENANT_ID,
      createdAt: "2026-08-11T18:08:42.158Z",
    });
    expect(parsed.currentSubscription).toMatchObject({
      startsAt: null,
      endsAt: null,
      createdAt: "2026-08-11T18:08:42.158Z",
      updatedAt: "2026-08-11T18:08:42.158Z",
    });
    expect(parsed.scheduledSubscription).toBeNull();
  });

  it("keeps tenant params opaque but bounded", () => {
    expect(platformTenantContracts.detail.params.parse({ id: LEGACY_TENANT_ID })).toEqual({
      id: LEGACY_TENANT_ID,
    });
    expect(platformTenantContracts.detail.params.safeParse({ id: "x".repeat(129) }).success).toBe(
      false,
    );
  });

  it("parses create results without requiring a UUID tenant reference", () => {
    expect(
      platformTenantContracts.create.response.parse({
        tenantId: LEGACY_TENANT_ID,
        userId: "legacy_owner",
        memberId: "legacy_member",
        deliveryId: "61111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      tenantId: LEGACY_TENANT_ID,
      userId: "legacy_owner",
      memberId: "legacy_member",
      deliveryId: "61111111-1111-4111-8111-111111111111",
    });
  });

  it("parses the assignable plan and add-on catalog used by tenant detail", () => {
    const { entitlements: plan, ...assignablePlanVersion } = planVersion;
    const parsed = assignableCatalogResponseSchema.parse({
      items: [
        {
          ...assignablePlanVersion,
          descriptionRu: null,
          descriptionEn: null,
          publishedAt: "2026-08-11 18:08:42.158",
          publishedByPlatformUserId: "platform_admin",
          plan,
        },
        {
          id: ADDON_VERSION_ID,
          catalogItemId: "71111111-1111-4111-8111-111111111111",
          catalogItemCode: "addon-station",
          kind: "addon",
          version: 2,
          status: "published",
          nameRu: "Дополнительная станция",
          nameEn: "Extra station",
          descriptionRu: null,
          descriptionEn: null,
          unit: "station",
          billingMode: "recurring",
          billingPeriod: "month",
          unitPrice: "2500.00",
          vatRateBps: 2000,
          vatIncluded: true,
          publishedAt: "2026-08-11 18:08:42.158+00",
          publishedByPlatformUserId: "platform_admin",
          addon: { effects: [{ key: "stations", quotaIncrement: 1 }] },
        },
      ],
    });

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      kind: "plan",
      publishedAt: "2026-08-11T18:08:42.158Z",
    });
    expect(parsed.items[1]).toMatchObject({
      kind: "addon",
      publishedAt: "2026-08-11T18:08:42.158Z",
    });
  });

  it("parses normalized plan and add-on assignment results", () => {
    const plan = platformTenantContracts.assignPlan.response.parse({
      id: "81111111-1111-4111-8111-111111111111",
      tenantId: LEGACY_TENANT_ID,
      planVersionId: PLAN_VERSION_ID,
      status: "active",
      startsAt: "2026-08-11 18:08:42.158",
      endsAt: null,
      source: "manual",
    });
    const addon = platformTenantContracts.assignAddon.response.parse({
      id: "91111111-1111-4111-8111-111111111111",
      tenantId: LEGACY_TENANT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      addonVersionId: ADDON_VERSION_ID,
      quantity: 2,
      startsAt: "2026-08-11 18:08:42.158+00",
      endsAt: null,
      status: "active",
      source: "manual",
    });

    expect(plan).toMatchObject({
      tenantId: LEGACY_TENANT_ID,
      startsAt: "2026-08-11T18:08:42.158Z",
      endsAt: null,
    });
    expect(addon).toMatchObject({
      tenantId: LEGACY_TENANT_ID,
      quantity: 2,
      startsAt: "2026-08-11T18:08:42.158Z",
      endsAt: null,
    });
  });
});
