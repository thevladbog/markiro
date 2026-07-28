import { afterEach, describe, expect, it, vi } from "vitest";
import { createKioskClient, KioskApiError, pairKiosk } from "../src/api/client.js";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("pairKiosk", () => {
  it("posts the code without any credential header", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(201, { token: "t", nextDeviceSeq: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await pairKiosk("http://srv/", "12345678");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://srv/kiosk/pair"); // trailing slash stripped
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ code: "12345678" });
    expect((init as RequestInit).headers).not.toHaveProperty("x-kiosk-token");
  });

  it("surfaces the server's message on rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { message: "Unauthorized" })),
    );
    await expect(pairKiosk("http://srv", "00000000")).rejects.toBeInstanceOf(KioskApiError);
  });
});

describe("createKioskClient", () => {
  it("sends the device token on every authenticated call", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { generatedAt: "2026-07-28T00:00:00Z" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createKioskClient({ token: "tok", serverUrl: "http://srv" }).bootstrap();

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "x-kiosk-token": "tok" });
  });

  it("carries the scan time so a late sync is not recorded as happening now", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(201, { orderNo: "ORD-26-0001", conflicts: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createKioskClient({ token: "tok", serverUrl: "http://srv" }).submitOrder({
      deviceSeq: 3,
      badgeCode: "B-1",
      reason: "buy",
      items: [{ rawKm: "01..." }],
      createdAt: "2026-07-28T06:00:00.000Z",
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ deviceSeq: 3, createdAt: "2026-07-28T06:00:00.000Z" });
  });
});
