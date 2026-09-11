import { afterEach, expect, it, vi } from "vitest";
import {
  listCatalogVersions,
  createCatalogVersion,
  catalogVersionToCreateInput,
} from "../src/pages/catalog/api.js";
import { DRAFT_PLAN, jsonResponse } from "./render.js";
afterEach(() => vi.unstubAllGlobals());
it("reads explicit V3 modules and policy without widening saved V2 documents", async () => {
  const plan = {
    ...DRAFT_PLAN,
    lifecyclePolicyId: null,
    plan: {
      ...DRAFT_PLAN.plan,
      chzIntegrationEnabled: true,
      inventoryEnabled: false,
      commerceMlEnabled: false,
      handheldEnabled: false,
    },
  };
  const fetch = vi.fn(async () => jsonResponse(200, { items: [plan] }));
  vi.stubGlobal("fetch", fetch);
  expect((await listCatalogVersions()).items[0]).toEqual(plan);
  expect(fetch.mock.calls[0]).toBeDefined();
  const init = (fetch.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[1];
  expect(init?.headers).toMatchObject({ "X-Markiro-Commercial-Version": "3" });
});
it("clones fully legacy unknown mapping through frozen V2 and preserves nulls in the V3 response view", async () => {
  const legacy = {
    ...DRAFT_PLAN,
    lifecyclePolicyId: null,
    plan: {
      ...DRAFT_PLAN.plan,
      chzIntegrationEnabled: null,
      inventoryEnabled: null,
      commerceMlEnabled: null,
      handheldEnabled: null,
    },
  };
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init: RequestInit) => {
      calls.push(init);
      const { lifecyclePolicyId: _, ...v2 } = legacy;
      const {
        chzIntegrationEnabled: _c,
        inventoryEnabled: _i,
        commerceMlEnabled: _m,
        handheldEnabled: _h,
        ...plan
      } = v2.plan;
      void _;
      void _c;
      void _i;
      void _m;
      void _h;
      return jsonResponse(201, { ...v2, plan });
    }),
  );
  const result = await createCatalogVersion(
    legacy.catalogItemCode,
    catalogVersionToCreateInput(legacy),
  );
  expect(calls[0]?.headers).toMatchObject({ "X-Markiro-Commercial-Version": "2" });
  expect(JSON.parse(String(calls[0]?.body)).plan).not.toHaveProperty("chzIntegrationEnabled");
  expect(result.plan?.chzIntegrationEnabled).toBeNull();
});
it("does not silently clone partial or policy-bound unknown mapping using legacy defaults", () => {
  const legacy = {
    ...DRAFT_PLAN,
    lifecyclePolicyId: null,
    plan: {
      ...DRAFT_PLAN.plan,
      chzIntegrationEnabled: null,
      inventoryEnabled: true,
      commerceMlEnabled: null,
      handheldEnabled: null,
    },
  };
  expect(() => catalogVersionToCreateInput(legacy)).toThrow();
});

it("negotiates V3 for new invoice and offer selections without adding entitlement fields to saved line shapes", async () => {
  const { createInvoice } = await import("../src/pages/billing/api.js");
  const { createOffer } = await import("../src/pages/offers/api.js");
  const { createLineFromCatalog, toInvoiceCreateInput, toOfferCreateInput } =
    await import("../src/pages/documents/documentDraft.js");
  const version = { ...DRAFT_PLAN, plan: { ...DRAFT_PLAN.plan, chzIntegrationEnabled: true } };
  const draft = {
    tenantId: "81111111-1111-4111-8111-111111111111",
    date: "",
    applicationMode: "automatic" as const,
    lines: [{ ...createLineFromCatalog(version, "line"), activationPolicy: "immediate" as const }],
  };
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(init);
      return jsonResponse(409, { code: "fixture_refusal" });
    }),
  );
  await expect(
    createInvoice({
      ...toInvoiceCreateInput(draft),
      idempotencyKey: "11111111-1111-4111-8111-111111111112",
    }),
  ).rejects.toMatchObject({ code: "fixture_refusal" });
  await expect(createOffer(toOfferCreateInput(draft))).rejects.toMatchObject({
    code: "fixture_refusal",
  });
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(new Headers(call.headers).get("X-Markiro-Commercial-Version")).toBe("3");
    const body = JSON.parse(String(call.body));
    expect(body.lines[0].catalogVersionId).toBe(version.id);
    expect(body.lines[0]).not.toHaveProperty("plan");
    expect(body.lines[0]).not.toHaveProperty("lifecyclePolicyId");
  }
});
