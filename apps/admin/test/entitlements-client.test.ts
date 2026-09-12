import { afterEach, expect, it, vi } from "vitest";
import { getBillingEntitlements } from "../src/pages/billing/entitlements-api.js";
import { ENTITLEMENT_SNAPSHOT } from "./entitlements-fixture.js";
afterEach(() => vi.unstubAllGlobals());
it("reads only the safe entitlement endpoint and rejects platform decision details", async () => {
  const calls: string[] = [];
  let response: unknown = ENTITLEMENT_SNAPSHOT;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(response), { status: 200 });
    }),
  );
  expect(await getBillingEntitlements()).toEqual(ENTITLEMENT_SNAPSHOT);
  expect(calls).toEqual(["/api/access/entitlements"]);
  response = {
    ...ENTITLEMENT_SNAPSHOT,
    sourceDetails: [{ decisionReference: "internal-decision" }],
  };
  await expect(getBillingEntitlements()).rejects.toThrow();
  response = {
    ...ENTITLEMENT_SNAPSHOT,
    sources: ENTITLEMENT_SNAPSHOT.sources.map((source) => ({
      ...source,
      decisionReference: "internal-decision",
    })),
  };
  await expect(getBillingEntitlements()).rejects.toThrow();
});
