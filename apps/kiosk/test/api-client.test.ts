import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_TIMEOUT_MS,
  createKioskClient,
  isDeviceRevoked,
  isUnreachable,
  KioskApiError,
  KioskTimeoutError,
  pairKiosk,
  SUBMIT_TIMEOUT_MS,
} from "../src/api/client.js";
import { REFRESH_INTERVAL_MS } from "../src/sync/worker.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
      badgeDigest: "B-1",
      reason: "buy",
      items: [{ rawKm: "01..." }],
      createdAt: "2026-07-28T06:00:00.000Z",
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ deviceSeq: 3, createdAt: "2026-07-28T06:00:00.000Z" });
  });
});

/**
 * THE STALL THAT STOPS A KIOSK DEAD.
 *
 * A refused connection is loud and already handled. The one that costs is the
 * half-open one — a tablet carried out of Wi-Fi range mid-request, or a captive
 * portal swallowing the SYN — where `fetch` neither resolves nor rejects. Every
 * promise chained behind it (`flushQueue`'s `draining`, the `submitCart` the
 * worker is standing there waiting on) is then owed forever.
 *
 * The fetch below models exactly that, in two flavours: one that honours the
 * abort as a conforming implementation does, and one that ignores the signal
 * completely — which is what a service worker in the way could amount to, and
 * is why the deadline does not rest on `fetch` behaving.
 */
describe("request deadlines", () => {
  /** A request that never settles on its own. `honoursAbort: false` ignores the
   * signal too, so nothing but the deadline itself can end it. */
  function hangingFetch(honoursAbort: boolean) {
    return vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (!honoursAbort) return;
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
  }

  it("gives an order submit a deadline instead of hanging forever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", hangingFetch(true));
    const client = createKioskClient({ token: "tok", serverUrl: "http://srv" });

    let settled = false;
    const submit = client
      .submitOrder({ deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] })
      .catch((err: unknown) => {
        settled = true;
        return err;
      });

    // One millisecond short of the bound, the request is still legitimately in
    // flight: a deadline that fired early would abort a slow-but-working link.
    await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await submit).toBeInstanceOf(KioskTimeoutError);
  });

  it("settles even when the request ignores the abort signal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", hangingFetch(false));
    const client = createKioskClient({ token: "tok", serverUrl: "http://srv" });

    // The handler goes on BEFORE the clock moves: attaching it afterwards
    // leaves the rejection unobserved for a tick, which Vitest reports as an
    // unhandled rejection in whichever file happens to be running.
    const bootstrap = client.bootstrap().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS);

    expect(await bootstrap).toBeInstanceOf(KioskTimeoutError);
  });

  /**
   * The distinction the drain's quarantine turns on. A timeout carries NO
   * server verdict — the order may even have been filed — so it must never look
   * like a 4xx, or an aborted submit would be filed away as permanently
   * refused and the worker's pickup would never be delivered.
   */
  it("reports a timeout as its own error, never as an API status", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", hangingFetch(true));
    const client = createKioskClient({ token: "tok", serverUrl: "http://srv" });

    const submit = client
      .submitOrder({ deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] })
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS);

    const err = await submit;
    expect(err).not.toBeInstanceOf(KioskApiError);
    expect(isDeviceRevoked(err)).toBe(false);
  });

  // The abort is what frees the socket; the race only guarantees the promise
  // settles. Both have to happen, or a kiosk on a flapping link accumulates
  // sockets it will never read.
  it("aborts the underlying request as well as giving up on it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = hangingFetch(true);
    vi.stubGlobal("fetch", fetchMock);
    const client = createKioskClient({ token: "tok", serverUrl: "http://srv" });

    const submit = client
      .submitOrder({ deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] })
      .catch(() => {});
    const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS);
    await submit;

    expect(signal.aborted).toBe(true);
  });

  // The server answered. Turning that into a retryable timeout would hide a
  // revocation — the device would go on retrying a token that is never coming
  // back, instead of being sent to pairing.
  it("keeps the server's own verdict when one arrived", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { message: "Unauthorized" })),
    );

    const err = await createKioskClient({ token: "stale", serverUrl: "http://srv" })
      .bootstrap()
      .catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(KioskApiError);
    expect(isDeviceRevoked(err)).toBe(true);
  });

  /**
   * The bootstrap carries the whole roster, catalogue and operator mirror, so
   * it is the slowest legitimate call the app makes and gets the longer bound;
   * an order submit is a handful of codes with a worker standing in front of
   * the screen, so it gets the shorter one. And the bootstrap's bound stays
   * well inside the refresh interval, or a stalled refresh would still be in
   * flight when the next one starts.
   */
  it("tolerates a slow bootstrap more than a slow submit, and both less than one refresh", () => {
    expect(SUBMIT_TIMEOUT_MS).toBeLessThan(BOOTSTRAP_TIMEOUT_MS);
    expect(BOOTSTRAP_TIMEOUT_MS).toBeLessThan(REFRESH_INTERVAL_MS / 2);
  });
});

/**
 * WHAT "REACHED THE SERVER" ACTUALLY MEANS, and the distinction a live smoke
 * run showed the app had never drawn.
 *
 * Stopping the API produced no transport failure at all: the proxy in front of
 * it answered `502 Bad Gateway`. The device therefore held a `KioskApiError`,
 * which everything downstream read as "the application answered" — so the
 * status strip went on asserting a link and the drain's backoff never armed.
 *
 * `502`/`503`/`504` are the statuses a GATEWAY raises about an upstream it
 * could not reach; every other status is the application's own verdict on the
 * request and keeps meaning exactly what it did.
 */
describe("isUnreachable", () => {
  it.each([502, 503, 504])(
    "reads a gateway's %i as never having reached the application",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(status, { message: "no upstream available" })),
      );

      const err = await createKioskClient({ token: "tok", serverUrl: "http://srv" })
        .submitOrder({ deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] })
        .catch((caught: unknown) => caught);

      // Still the server's verdict as far as the transport is concerned — the
      // status is not swallowed, only read for what it says about the upstream.
      expect(err).toBeInstanceOf(KioskApiError);
      expect(isUnreachable(err)).toBe(true);
      // And never a revocation: a gateway holds no opinion about this device.
      expect(isDeviceRevoked(err)).toBe(false);
    },
  );

  /**
   * The statuses the application itself produces, INCLUDING a genuine 500. A
   * handler that threw has been reached, and telling a worker «нет связи» about
   * a server-side bug would send an administrator after a network that is fine.
   */
  it.each([400, 401, 404, 409, 422, 429, 500])(
    "reads %i as the application's own answer",
    (status) => {
      expect(isUnreachable(new KioskApiError(status, "answered"))).toBe(false);
    },
  );

  it("reads a failure carrying no answer at all as never having reached anything", () => {
    expect(isUnreachable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isUnreachable(new KioskTimeoutError(SUBMIT_TIMEOUT_MS))).toBe(true);
  });
});

describe("isDeviceRevoked", () => {
  it("is true only for the guard's 401, not for any other refusal", () => {
    expect(isDeviceRevoked(new KioskApiError(401, "Unauthorized"))).toBe(true);
    expect(isDeviceRevoked(new KioskApiError(400, "Unknown or archived writeoff reason"))).toBe(
      false,
    );
    expect(isDeviceRevoked(new KioskApiError(500, "boom"))).toBe(false);
    expect(isDeviceRevoked(new TypeError("Failed to fetch"))).toBe(false);
    expect(isDeviceRevoked(new KioskTimeoutError(1_000))).toBe(false);
  });
});
