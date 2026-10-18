import {
  factualObservation,
  preview,
} from "../../../apps/saas-admin/test/device-replacement-fixtures.js";
import {
  STANDALONE_PREVIEW,
  STANDALONE_SITE_ID,
  STANDALONE_SITE_LIST,
} from "../../../apps/saas-admin/test/standalone-fixtures.js";
import type {
  DeviceReplacementPreparation,
  DeviceRetentionInspection,
} from "../../../packages/platform-contracts/src/index.js";
import { test as base, expect } from "@playwright/test";
import type { Route } from "@playwright/test";
import {
  platformCapabilitiesForRole,
  platformDeviceReplacementContracts,
  platformDeviceLicensingContracts,
  platformTenantV3Contracts,
  standaloneIssuancePreviewSchema,
} from "../../../packages/platform-contracts/src/index.js";

export const TENANT_ID = "81111111-1111-4111-8111-111111111111";

const tenant = platformTenantV3Contracts.detail.response.parse({
  tenant: {
    id: TENANT_ID,
    name: "Первый завод",
    slug: "first-factory",
    cabinetAccess: "enabled",
    createdAt: "2026-08-09T08:00:00.000Z",
  },
  subscriptionStatus: "unmanaged",
  ownerActivation: null,
  currentSubscription: null,
  scheduledSubscription: null,
  activeAddons: [],
  scheduledAddons: [],
  usage: { cabinetUsers: 5, kiosks: 1, lines: 3, stations: 5 },
  events: [],
});

const ASSIGNED_PLAN_VERSION_ID = "92111111-1111-4111-8111-111111111111";
const ASSIGNED_SUBSCRIPTION_ID = "b1111111-1111-4111-8111-111111111111";

/** A tenant without a cabinet and its direct assignments: a plan and an add-on (spec 2026-10-16). */
const offlineTenant = platformTenantV3Contracts.detail.response.parse({
  tenant: {
    id: TENANT_ID,
    name: "Первый завод",
    slug: "first-factory",
    cabinetAccess: "none",
    createdAt: "2026-08-09T08:00:00.000Z",
  },
  subscriptionStatus: "unmanaged",
  ownerActivation: null,
  currentSubscription: {
    commercialPeriod: null,
    id: ASSIGNED_SUBSCRIPTION_ID,
    tenantId: TENANT_ID,
    planVersionId: ASSIGNED_PLAN_VERSION_ID,
    status: "active",
    startsAt: "2026-08-08T08:00:00.000Z",
    endsAt: null,
    source: "manual",
    createdByPlatformUserId: "fixture-admin",
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-10T08:00:00.000Z",
    planVersion: {
      id: ASSIGNED_PLAN_VERSION_ID,
      catalogItemId: "21111111-1111-4111-8111-111111111111",
      catalogItemCode: "plan-standalone",
      documentNameRu: null,
      documentNameEn: null,
      subject: null,
      sellerPolicyRevision: null,
      lifecyclePolicyId: null,
      kind: "plan",
      version: 1,
      status: "published",
      nameRu: "Автоном",
      nameEn: "Standalone",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "15000.00",
      vatRateBps: 2000,
      vatIncluded: true,
      entitlements: {
        maxLines: 2,
        maxStations: 3,
        maxKiosks: 0,
        maxCabinetUsers: 5,
        labelEditorEnabled: true,
        publicApiEnabled: false,
        palletsEnabled: true,
        chzIntegrationEnabled: false,
        inventoryEnabled: false,
        commerceMlEnabled: false,
        handheldEnabled: false,
        customLogoEnabled: false,
        demoDurationDays: null,
      },
    },
  },
  scheduledSubscription: null,
  activeAddons: [
    {
      id: "e1111111-1111-4111-8111-111111111111",
      commercialPeriod: null,
      subscriptionId: ASSIGNED_SUBSCRIPTION_ID,
      addonVersionId: "93111111-1111-4111-8111-111111111111",
      quantity: 2,
      startsAt: "2026-08-11T08:00:00.000Z",
      endsAt: "2099-01-01T00:00:00.000Z",
      status: "active",
      source: "manual",
      addonVersion: {
        id: "93111111-1111-4111-8111-111111111111",
        catalogItemId: "71111111-1111-4111-8111-111111111111",
        catalogItemCode: "addon-station",
        documentNameRu: null,
        documentNameEn: null,
        subject: null,
        sellerPolicyRevision: null,
        lifecyclePolicyId: null,
        kind: "addon",
        version: 1,
        status: "published",
        nameRu: "Дополнительная станция",
        nameEn: "Extra station",
        unit: "station",
        billingMode: "recurring",
        billingPeriod: "month",
        unitPrice: "2500.00",
        vatRateBps: 2000,
        vatIncluded: true,
        effects: [{ entitlementKey: "stations", quotaIncrement: 1, featureEnabled: false }],
      },
    },
  ],
  scheduledAddons: [],
  usage: { cabinetUsers: 0, kiosks: 0, lines: 0, stations: 0 },
  events: [],
});

const assignmentsPreview = standaloneIssuancePreviewSchema.parse({
  ...STANDALONE_PREVIEW,
  next: {
    ...STANDALONE_PREVIEW.next,
    source: "offline_assignments",
    validUntilReason: "one_year_cap",
    sourceAssignments: [
      { kind: "plan", id: ASSIGNED_SUBSCRIPTION_ID, catalogVersionId: ASSIGNED_PLAN_VERSION_ID },
      {
        kind: "addon",
        id: "e1111111-1111-4111-8111-111111111111",
        catalogVersionId: "93111111-1111-4111-8111-111111111111",
      },
    ],
  },
  expected: { ...STANDALONE_PREVIEW.expected, boundaryAt: null },
});

const devicePool = platformDeviceLicensingContracts.inspect.response.parse({
  tenantId: TENANT_ID,
  usage: 3,
  limit: 5,
  canCancelReservations: true,
  integrity: "ready",
  devices: [
    {
      deviceId: "16111111-1111-4111-8111-111111111111",
      name: "Линия розлива 1",
      kind: "station",
      assignmentId: "17111111-1111-4111-8111-111111111111",
      revision: 4,
      state: "assigned",
      releaseReason: null,
      slotOccupied: true,
      canCancel: false,
      blockedReason: "already_paired",
      connectionStatus: "online",
      pairedAt: "2026-08-10T08:00:00.000Z",
      lastSeenAt: "2026-09-16T08:58:00.000Z",
    },
    {
      deviceId: "18111111-1111-4111-8111-111111111111",
      name: "ТСД склада",
      kind: "handheld",
      assignmentId: "19111111-1111-4111-8111-111111111111",
      revision: 1,
      state: "reserved",
      releaseReason: null,
      slotOccupied: true,
      canCancel: true,
      blockedReason: null,
      connectionStatus: "awaiting_pairing",
      pairedAt: null,
      lastSeenAt: null,
    },
    {
      deviceId: "20111111-1111-4111-8111-111111111111",
      name: "Станция упаковки",
      kind: "station",
      assignmentId: "21111111-1111-4111-8111-111111111111",
      revision: 2,
      state: "assigned",
      releaseReason: null,
      slotOccupied: true,
      canCancel: false,
      blockedReason: "production_evidence",
      connectionStatus: "offline",
      pairedAt: "2026-08-11T08:00:00.000Z",
      lastSeenAt: "2026-09-15T18:00:00.000Z",
    },
  ],
});

function makeFixture() {
  return {
    offlineAssignments: false,
    replacementPreviewBlocked: false,
    replacementDrainRefused: false,
    refusedDrainAttempts: 0,
    unhandled: [] as string[],
    replacement: null as DeviceReplacementPreparation | null,
    retentionShadow: {
      awaitingSelection: false,
      affectedDeviceIds: [],
      enforced: false,
    } as DeviceRetentionInspection["currentShadow"],
  };
}

export const test = base.extend<{ fixture: ReturnType<typeof makeFixture> }>({
  fixture: async ({ context, baseURL }, use) => {
    const fixture = makeFixture();
    const origin = new URL(baseURL!).origin;
    await context.route("**/*", async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        fixture.unhandled.push(request.url());
        await route.abort();
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        await route.continue();
        return;
      }
      const method = request.method();
      let json: unknown;
      if (url.pathname === "/api/platform-auth/get-session" && method === "GET") {
        json = {
          session: { id: "fixture-session", expiresAt: "2027-01-01T00:00:00Z" },
          user: {
            id: "fixture-admin",
            email: "fixture@example.invalid",
            name: "Fixture",
            twoFactorEnabled: true,
          },
        };
      } else if (url.pathname === "/api/platform/me" && method === "GET") {
        json = {
          userId: "fixture-admin",
          role: "platform_admin",
          capabilities: platformCapabilitiesForRole.platform_admin,
          twoFactorReady: true,
        };
      } else if (url.pathname === `/api/platform/tenants/${TENANT_ID}` && method === "GET") {
        json = fixture.offlineAssignments ? offlineTenant : tenant;
      } else if (
        url.pathname === `/api/platform/tenants/${TENANT_ID}/device-licensing` &&
        method === "GET"
      ) {
        json = devicePool;
      } else if (
        url.pathname === `/api/platform/tenants/${TENANT_ID}/device-licensing/replacements` &&
        method === "GET"
      ) {
        json = {
          canPrepare: true,
          items: fixture.replacement
            ? [{ preparation: fixture.replacement, needsReview: false }]
            : [],
        };
      } else if (
        url.pathname === `/api/platform/tenants/${TENANT_ID}/standalone-sites` &&
        method === "GET"
      ) {
        json = fixture.offlineAssignments
          ? { ...STANDALONE_SITE_LIST, issuanceSource: "offline_assignments" }
          : STANDALONE_SITE_LIST;
      } else if (
        fixture.offlineAssignments &&
        url.pathname ===
          `/api/platform/tenants/${TENANT_ID}/standalone-sites/${STANDALONE_SITE_ID}/issuances/preview` &&
        method === "POST"
      ) {
        json = assignmentsPreview;
      } else if (
        url.pathname === `/api/platform/tenants/${TENANT_ID}/device-licensing/retention` &&
        method === "GET"
      ) {
        json = {
          canSelect: false,
          observation: null,
          selections: [],
          currentShadow: fixture.retentionShadow,
        };
      } else if (
        fixture.replacementDrainRefused &&
        method === "POST" &&
        url.pathname.endsWith("/drain")
      ) {
        platformDeviceReplacementContracts.drain.body.parse(request.postDataJSON());
        if (!fixture.replacement) throw new Error("Missing preparation");
        fixture.replacement = {
          ...fixture.replacement,
          drainEligibility: { status: "blocked", reasons: ["client_upgrade_required"] },
        };
        fixture.refusedDrainAttempts++;
        await route.fulfill({
          status: 409,
          json: {
            code: "client_upgrade_required",
            message: "Replacement blocked",
            requestId: TENANT_ID,
          },
        });
        return;
      } else if (
        fixture.replacementPreviewBlocked &&
        method === "POST" &&
        url.pathname.endsWith("/replacements/preview")
      ) {
        const body = platformDeviceReplacementContracts.preview.body.parse(request.postDataJSON());
        const source = devicePool.devices[0];
        if (!source) throw new Error("Missing source fixture");
        json = {
          ...preview(body.requestId),
          sourceDeviceId: source.deviceId,
          observation: {
            ...factualObservation,
            source: {
              ...factualObservation.source,
              deviceId: source.deviceId,
              assignmentId: source.assignmentId,
              name: source.name,
            },
            target: body.target,
          },
        };
      } else {
        fixture.unhandled.push(`${method} ${url.pathname}${url.search}`);
        await route.abort();
        return;
      }
      await route.fulfill({ json, headers: { "Cache-Control": "no-store" } });
    });
    await use(fixture);
    await context.unrouteAll({ behavior: "wait" });
    expect(fixture.unhandled, "Every API request must be explicitly intercepted").toEqual([]);
  },
});

export { expect };
