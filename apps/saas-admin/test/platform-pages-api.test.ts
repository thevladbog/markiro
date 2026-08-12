import { describe, expect, it, vi } from "vitest";
import { listAuditEvents } from "../src/pages/audit/api.js";
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
});
