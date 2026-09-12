import { afterEach, describe, expect, it, vi } from "vitest";
import { platformTenantV2Contracts, platformCatalogV2Contracts } from "@markiro/platform-contracts";
import { TENANT_DETAIL, DRAFT_PLAN } from "./render.js";
import {
  DRAFT_PLAN as LEGACY_PLAN,
  ADDON as LEGACY_ADDON,
  SERVICE as LEGACY_SERVICE,
} from "./commercial-v2-fixtures.js";
describe("current commercial fixtures", () => {
  it("represents tenant purchased periods and zero-capable catalog responses", () => {
    platformTenantV2Contracts.detail.response.parse({
      tenant: {
        id: "81111111-1111-4111-8111-111111111111",
        name: "Legacy tenant",
        slug: "legacy",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
      subscriptionStatus: "unmanaged",
      ownerActivation: null,
      currentSubscription: null,
      scheduledSubscription: null,
      activeAddons: [],
      scheduledAddons: [],
      usage: { lines: 0, stations: 0, kiosks: 0, cabinetUsers: 0 },
      events: [],
    });
    expect(
      platformCatalogV2Contracts.list.response.safeParse({
        items: [LEGACY_PLAN, LEGACY_ADDON, LEGACY_SERVICE],
      }),
    ).toMatchObject({ success: true });
  });
});

import { listCatalogVersions, publishCatalogVersion } from "../src/pages/catalog/api.js";
import { getTenant } from "../src/pages/tenants/api.js";
import { getOperatorBillingProfile } from "../src/pages/settings/api.js";
import { PUBLISHED_PLAN, TENANT_ID, jsonResponse } from "./render.js";
afterEach(() => vi.unstubAllGlobals());
it("negotiates V3 for current selections while seller settings retain V2", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(init);
      const path = String(input);
      if (path.endsWith("/catalog/items"))
        return jsonResponse(200, {
          items: [{ ...DRAFT_PLAN, plan: { ...DRAFT_PLAN.plan, maxKiosks: 0 } }],
        });
      if (path.endsWith("/publish")) return jsonResponse(200, PUBLISHED_PLAN);
      if (path.endsWith("/operator-profile")) return jsonResponse(200, null);
      return jsonResponse(200, TENANT_DETAIL);
    }),
  );
  expect((await listCatalogVersions()).items[0]?.plan?.maxKiosks).toBe(0);
  await getTenant(TENANT_ID);
  await getOperatorBillingProfile();
  const identity = {
    catalogVersionId: PUBLISHED_PLAN.id,
    draftUpdatedAt: "2026-09-10T10:00:00.000Z",
    sellerPolicyRevision: 1,
    lifecyclePolicyId: PUBLISHED_PLAN.lifecyclePolicyId,
    lifecyclePolicyVersion: 1,
    lifecyclePolicyHash: "a".repeat(64),
  };
  await publishCatalogVersion(PUBLISHED_PLAN.catalogItemCode, PUBLISHED_PLAN.id, identity);
  expect(
    calls.map((call) => new Headers(call.headers).get("X-Markiro-Commercial-Version")),
  ).toEqual(["3", "3", "2", "3"]);
  expect(JSON.parse(String(calls.at(-1)?.body))).toEqual(identity);
});
