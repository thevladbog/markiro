import {
  factualObservation,
  preview,
} from "../../../apps/saas-admin/test/device-replacement-fixtures.js";
import type { DeviceReplacementPreparation } from "../../../packages/platform-contracts/src/index.js";
import { test as base, expect } from "@playwright/test";
import type { Route } from "@playwright/test";
import {
  platformCapabilitiesForRole,
  platformDeviceReplacementContracts,
  platformDeviceLicensingContracts,
  platformTenantV3Contracts,
} from "../../../packages/platform-contracts/src/index.js";

export const TENANT_ID = "81111111-1111-4111-8111-111111111111";

const tenant = platformTenantV3Contracts.detail.response.parse({
  tenant: {
    id: TENANT_ID,
    name: "Первый завод",
    slug: "first-factory",
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
    replacementPreviewBlocked: false,
    unhandled: [] as string[],
    replacement: null as DeviceReplacementPreparation | null,
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
        json = tenant;
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
        url.pathname === `/api/platform/tenants/${TENANT_ID}/device-licensing/retention` &&
        method === "GET"
      ) {
        json = {
          canSelect: false,
          observation: null,
          selections: [],
          currentShadow: { awaitingSelection: false, affectedDeviceIds: [], enforced: false },
        };
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
