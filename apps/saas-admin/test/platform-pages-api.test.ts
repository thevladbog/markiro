import { describe, expect, it, vi } from "vitest";
import { listAuditEvents } from "../src/pages/audit/api.js";
import { getOffer, listOffers } from "../src/pages/offers/api.js";
import { listPlatformTeam } from "../src/pages/team/api.js";

describe("platform page API paths", () => {
  it("uses the client platform base exactly once for team and audit", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return new Response(
        url.endsWith("/team")
          ? JSON.stringify([])
          : JSON.stringify({ items: [], nextOffset: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await listPlatformTeam();
    await listAuditEvents({ limit: 2 });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/platform/team",
      "/api/platform/audit?limit=2&offset=0",
    ]);
  });

  it("keeps an expired offer in a mixed registry response", async () => {
    const id = "a1111111-1111-4111-8111-111111111111";
    const expired = {
      id,
      tenantId: "81111111-1111-4111-8111-111111111111",
      status: "expired",
      total: "100.00",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: "a2111111-1111-4111-8111-111111111111",
                tenantId: expired.tenantId,
                status: "published",
                total: "200.00",
              },
              expired,
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(listOffers()).resolves.toEqual([
      {
        id: "a2111111-1111-4111-8111-111111111111",
        tenantId: expired.tenantId,
        status: "published",
        total: "200.00",
      },
      expired,
    ]);
  });

  it("parses an expired offer detail response", async () => {
    const id = "a1111111-1111-4111-8111-111111111111";
    const expired = {
      id,
      tenantId: "81111111-1111-4111-8111-111111111111",
      status: "expired",
      total: "100.00",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...expired,
              expiresAt: "2026-08-01T00:00:00.000Z",
              lines: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(getOffer(id)).resolves.toEqual({
      ...expired,
      expiresAt: "2026-08-01T00:00:00.000Z",
      lines: [],
    });
  });
});
