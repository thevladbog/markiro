import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../src/api/client.js";
import {
  addServiceApproval,
  listServicePeriods,
  postServiceUsage,
} from "../src/pages/service-periods/api.js";
import { serviceAttemptNotice } from "../src/pages/service-periods/attempt-state.js";
import { jsonResponse } from "./render.js";

afterEach(() => vi.unstubAllGlobals());

describe("service period platform client", () => {
  it("sends cursor filters and exact mutation request identities", async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push([String(input), init]);
        if (!init.method) return jsonResponse(200, { items: [], nextCursor: null });
        return jsonResponse(200, {
          revision: 2,
          balance: { included: 180, externallyApproved: 0, consumed: 45, remaining: 135 },
        });
      }),
    );
    const periodId = "11111111-1111-4111-8111-111111111111";
    const requestId = "22222222-2222-4222-8222-222222222222";
    await listServicePeriods({ tenantId: "tenant-a", state: "active", cursor: "next", limit: 20 });
    await postServiceUsage(periodId, {
      requestId,
      expectedRevision: 1,
      classification: "customer_service",
      performedAt: "2026-09-15T00:00:00.000Z",
      actualMinutes: 45,
      allowanceMinutes: 45,
      workReference: "SUP-42",
      description: "Настройка",
      internalNote: null,
    });
    await addServiceApproval(periodId, {
      requestId: "33333333-3333-4333-8333-333333333333",
      expectedRevision: 2,
      approvedMinutes: 30,
      externalReference: "APP-42",
      externalUrl: null,
      approvedAt: "2026-09-15T00:00:00.000Z",
      reason: "Approved",
    });
    expect(calls[0]?.[0]).toContain("tenantId=tenant-a");
    expect(calls[0]?.[0]).toContain("cursor=next");
    expect(JSON.parse(String(calls[1]?.[1].body))).toMatchObject({
      requestId,
      expectedRevision: 1,
      actualMinutes: 45,
    });
    expect(JSON.parse(String(calls[2]?.[1].body))).toMatchObject({
      expectedRevision: 2,
      approvedMinutes: 30,
    });
  });

  it("rejects local invalid mutations before transport", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => postServiceUsage("11111111-1111-4111-8111-111111111111", {} as never)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears only valid domain and authorization envelopes", () => {
    expect(
      serviceAttemptNotice(new ApiRequestError(409, "conflict", "revision", { kind: "domain" })),
    ).toBe("domain");
    expect(
      serviceAttemptNotice(
        new ApiRequestError(403, "forbidden", "forbidden", { kind: "authorization" }),
      ),
    ).toBe("authorization");
    expect(
      serviceAttemptNotice(new ApiRequestError(409, "malformed", null, { kind: "contract" })),
    ).toBe("uncertain");
  });
});
