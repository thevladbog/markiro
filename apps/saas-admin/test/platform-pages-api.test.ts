import { describe, expect, it, vi } from "vitest";
import { listAuditEvents } from "../src/pages/audit/api.js";
import {
  changePlatformRole,
  invitePlatformUser,
  listPlatformTeam,
  recoverPlatformTwoFactor,
  renewPlatformActivation,
  suspendPlatformUser,
} from "../src/pages/team/api.js";

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

  it("rejects malformed team and audit successes at the browser boundary", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return new Response(
        url.endsWith("/team")
          ? JSON.stringify([
              {
                id: "platform-user-1",
                name: "Administrator",
                email: "admin@example.invalid",
                role: "platform_admin",
                status: "active",
                twoFactorReady: true,
                createdAt: "not-a-timestamp",
              },
            ])
          : JSON.stringify({ items: [{ action: "platform.team.invited" }], nextOffset: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPlatformTeam()).rejects.toThrow();
    await expect(listAuditEvents()).rejects.toThrow();
  });

  it("validates every team mutation success at the browser boundary", async () => {
    const responses = new Map<string, unknown>([
      [
        "POST /api/platform/team",
        {
          userId: "platform-user-2",
          deliveryId: "11111111-1111-4111-8111-111111111111",
        },
      ],
      ["PATCH /api/platform/team/platform-user-2/role", { status: true }],
      ["POST /api/platform/team/platform-user-2/suspend", { status: true }],
      [
        "POST /api/platform/team/platform-user-2/activation/renew",
        {
          userId: "platform-user-2",
          deliveryId: "21111111-1111-4111-8111-111111111111",
        },
      ],
      ["POST /api/platform/team/platform-user-2/2fa/recover", { status: true }],
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init = {}) =>
        jsonResponse(responses.get(`${init.method ?? "GET"} ${String(input)}`)),
      ),
    );

    await expect(invitePlatformUser("user@example.invalid", "support")).resolves.toMatchObject({
      userId: "platform-user-2",
    });
    await expect(changePlatformRole("platform-user-2", "accountant")).resolves.toEqual({
      status: true,
    });
    await expect(suspendPlatformUser("platform-user-2")).resolves.toEqual({ status: true });
    await expect(renewPlatformActivation("platform-user-2")).resolves.toMatchObject({
      userId: "platform-user-2",
    });
    await expect(recoverPlatformTwoFactor("platform-user-2")).resolves.toEqual({ status: true });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
