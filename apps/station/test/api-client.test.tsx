import { afterEach, describe, expect, it, vi } from "vitest";
import { createStationClient, REQUEST_TIMEOUT_MS, StationApiError } from "../src/lib/api-client.js";
import {
  acquireCredentialCommitLease,
  createCredentialGeneration,
} from "../src/lib/credential-recovery.js";
import { redeemStationPairing } from "../src/lib/pairing.js";

/**
 * An externally-settleable `fetch` result, so a test can control exactly when
 * one concurrent request's `fetch` settles relative to another's -- no timers
 * or sleeps needed for deterministic ordering.
 */
function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createStationClient", () => {
  it("sends the x-api-key header and base-URLs from config", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      {
        machineId: "m1",
        tenantId: "org_1",
        apiKey: "mk_key",
        serverUrl: "http://localhost:3000",
      },
      { onReachabilityChange },
    );

    await client.get("/shifts");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:3000/shifts");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("mk_key");
    expect((init!.headers as Record<string, string>)["x-station-capabilities"]).toBe(
      "subscription-state-v1,station-recovery-v1,replacement-boundary-v1,replacement-readiness-v1,replacement-evidence-recovery-v1,validation-dm-duplicate-v1,validation-reprocessing-v1",
    );
    expect(onReachabilityChange).toHaveBeenCalledOnce();
    expect(onReachabilityChange).toHaveBeenLastCalledWith("reachable");
  });

  it("reports an HTTP error as reachable before throwing the API error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      { apiKey: "key", serverUrl: "https://station.example" },
      { onReachabilityChange },
    );

    await expect(client.get("/shifts")).rejects.toBeInstanceOf(StationApiError);
    expect(onReachabilityChange).toHaveBeenLastCalledWith("reachable");
  });

  it("reports fetch and timeout rejection as unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      { apiKey: "key", serverUrl: "https://station.example" },
      { onReachabilityChange },
    );

    await expect(client.get("/shifts")).rejects.toBeDefined();
    expect(onReachabilityChange).toHaveBeenLastCalledWith("unreachable");
  });

  // An older server's CORS policy does not list a newer display-only route,
  // so the webview's preflight fails and fetch rejects without a response.
  it("leaves reachability to the sync requests when a display-only read gets no response", async () => {
    const refusal = new TypeError("Failed to fetch");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(refusal);
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      { apiKey: "key", serverUrl: "https://station.example" },
      { onReachabilityChange },
    );

    await expect(client.get("/station/shifts/s1/progress", { displayOnly: true })).rejects.toBe(
      refusal,
    );
    expect(onReachabilityChange).not.toHaveBeenCalled();

    // The same failure on an ordinary read still reports the server unreachable.
    await expect(client.get("/station/shifts/s1/progress")).rejects.toBe(refusal);
    expect(onReachabilityChange.mock.calls).toEqual([["unreachable"]]);
  });

  // A display-only read must never take the newest sequence number for
  // itself: doing so (the bug this replaces) makes every earlier in-flight
  // request's later report stale, so a concurrent display-only GET can
  // silence the heartbeat or any other request that is still awaiting its
  // own answer.
  it("reports the plain request unreachable even though a display-only read overtook it and failed first", async () => {
    const plainFetch = deferredResponse();
    const displayFetch = deferredResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(plainFetch.promise)
      .mockReturnValueOnce(displayFetch.promise);
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      { apiKey: "key", serverUrl: "https://station.example" },
      { onReachabilityChange },
    );

    const plain = client.get("/shifts");
    const display = client.get("/station/shifts/s1/progress", { displayOnly: true });

    const displayFailure = new TypeError("Failed to fetch");
    displayFetch.reject(displayFailure);
    await expect(display).rejects.toBe(displayFailure);
    expect(onReachabilityChange).not.toHaveBeenCalled();

    const plainFailure = new TypeError("Failed to fetch");
    plainFetch.reject(plainFailure);
    await expect(plain).rejects.toBe(plainFailure);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onReachabilityChange.mock.calls).toEqual([["unreachable"]]);
  });

  it("reports a display-only read's HTTP answer as reachable, then still reports the plain request's own failure as unreachable", async () => {
    const plainFetch = deferredResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(plainFetch.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ shiftId: "s1" }), { status: 200 }));
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      { apiKey: "key", serverUrl: "https://station.example" },
      { onReachabilityChange },
    );

    const plain = client.get("/shifts");
    await client.get("/station/shifts/s1/progress", { displayOnly: true });
    expect(onReachabilityChange.mock.calls).toEqual([["reachable"]]);

    const plainFailure = new TypeError("Failed to fetch");
    plainFetch.reject(plainFailure);
    await expect(plain).rejects.toBe(plainFailure);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onReachabilityChange.mock.calls).toEqual([["reachable"], ["unreachable"]]);
  });

  it("does not let a display-only read's late answer report once a newer request has started", async () => {
    const displayFetch = deferredResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(displayFetch.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      { apiKey: "key", serverUrl: "https://station.example" },
      { onReachabilityChange },
    );

    const display = client.get("/station/shifts/s1/progress", { displayOnly: true });
    await client.get("/shifts");
    expect(onReachabilityChange.mock.calls).toEqual([["reachable"]]);

    displayFetch.resolve(new Response(JSON.stringify({ shiftId: "s1" }), { status: 200 }));
    await display;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onReachabilityChange.mock.calls).toEqual([["reachable"]]);
  });

  it("reports nothing for a display-only read that fails without a response when no other request is in flight", async () => {
    const refusal = new TypeError("Failed to fetch");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(refusal);
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      { apiKey: "key", serverUrl: "https://station.example" },
      { onReachabilityChange },
    );

    await expect(client.get("/station/shifts/s1/progress", { displayOnly: true })).rejects.toBe(
      refusal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onReachabilityChange).not.toHaveBeenCalled();
  });

  it.each([
    ["an answer", () => new Response(JSON.stringify({ shiftId: "s1" }), { status: 200 })],
    ["a 404", () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })],
  ])("still reports %s to a display-only read as reachable", async (_name, response) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      { apiKey: "key", serverUrl: "https://station.example" },
      { onReachabilityChange },
    );

    await client.get("/station/shifts/s1/progress", { displayOnly: true }).catch(() => undefined);

    expect(onReachabilityChange.mock.calls).toEqual([["reachable"]]);
  });

  it("seals the credential generation when a display-only read is refused as revoked", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "revoked", code: "STATION_CREDENTIAL_REVOKED" }), {
        status: 401,
      }),
    );
    const generation = createCredentialGeneration();
    const onCredentialRejected = vi.fn();
    const client = createStationClient(
      { machineId: "m1", apiKey: "revoked", serverUrl: "http://localhost:3000" },
      { credentialBoundary: { machineId: "m1", generation, onCredentialRejected } },
    );

    await expect(client.get("/station/shifts/s1/progress", { displayOnly: true })).rejects.toEqual(
      new StationApiError(401, "revoked", "STATION_CREDENTIAL_REVOKED"),
    );

    expect(generation.phase).toBe("sealed");
    expect(onCredentialRejected).toHaveBeenCalledTimes(1);
  });

  it("ignores an older transport failure after a newer request received an HTTP response", async () => {
    let rejectOlder: ((reason?: unknown) => void) | undefined;
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        new Promise<Response>((_resolve, reject) => {
          rejectOlder = reject;
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      { apiKey: "key", serverUrl: "https://station.example" },
      { onReachabilityChange },
    );

    const older = client.get("/station/operators");
    await client.get("/shifts");
    rejectOlder?.(new TypeError("late network failure"));
    await expect(older).rejects.toBeDefined();

    expect(onReachabilityChange.mock.calls).toEqual([["reachable"]]);
  });

  it("ignores an older HTTP success after a newer request failed to reach the server", async () => {
    let resolveOlder: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveOlder = resolve;
        }),
      )
      .mockRejectedValueOnce(new TypeError("newer network failure"));
    const onReachabilityChange = vi.fn();
    const client = createStationClient(
      { apiKey: "key", serverUrl: "https://station.example" },
      { onReachabilityChange },
    );

    const older = client.get("/station/operators");
    await expect(client.get("/shifts")).rejects.toBeDefined();
    resolveOlder?.(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await older;

    expect(onReachabilityChange.mock.calls).toEqual([["unreachable"]]);
  });

  it("throws with the server message on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "nope" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = createStationClient({
      machineId: "m1",
      apiKey: "bad",
      serverUrl: "http://localhost:3000",
    });
    await expect(client.get("/shifts")).rejects.toThrow("nope");
  });

  it("captures bounded documented error message and code without logging the response", async () => {
    const response = new Response(
      JSON.stringify({
        message: "A box label template is required",
        code: "BOX_LABEL_TEMPLATE_REQUIRED",
      }),
      { status: 422, statusText: "Unprocessable Entity" },
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const client = createStationClient({ apiKey: "key", serverUrl: "https://station.example" });

    const error = await client.get("/shifts").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StationApiError);
    expect(error).toMatchObject({
      status: 422,
      message: "A box label template is required",
      code: "BOX_LABEL_TEMPLATE_REQUIRED",
    });
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it.each([
    ["missing fields", {}, "Unprocessable Entity"],
    [
      "non-string fields",
      { message: ["not a message"], code: { value: "not a code" } },
      "Unprocessable Entity",
    ],
    [
      "oversized fields",
      { message: "m".repeat(257), code: "C".repeat(257) },
      "Unprocessable Entity",
    ],
    ["malformed JSON", "{", "Unprocessable Entity"],
  ])("falls back safely for %s error content", async (_name, body, expectedMessage) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: 422,
        statusText: "Unprocessable Entity",
      }),
    );
    const client = createStationClient({ apiKey: "key", serverUrl: "https://station.example" });

    const error = await client.get("/shifts").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StationApiError);
    expect(error).toMatchObject({ status: 422, message: expectedMessage });
    expect((error as StationApiError).code).toBeUndefined();
  });

  it("seals an authenticated generation for an explicit server revocation code", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "revoked", code: "STATION_CREDENTIAL_REVOKED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const generation = createCredentialGeneration();
    const lease = acquireCredentialCommitLease(generation)!;
    const onCredentialRejected = vi.fn();
    const client = createStationClient(
      { machineId: "m1", apiKey: "revoked", serverUrl: "http://localhost:3000" },
      { credentialBoundary: { machineId: "m1", generation, onCredentialRejected } },
    );

    const rejected = client.get("/station/operators");
    let settled = false;
    void rejected
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(generation.phase).toBe("sealing"));

    expect(settled).toBe(false);
    expect(onCredentialRejected).not.toHaveBeenCalled();
    await expect(client.get("/shifts")).rejects.toThrow("credential generation is sealed");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    lease.release();
    await expect(rejected).rejects.toEqual(
      new StationApiError(401, "revoked", "STATION_CREDENTIAL_REVOKED"),
    );
    expect(generation.phase).toBe("sealed");
    expect(onCredentialRejected).toHaveBeenCalledTimes(1);
  });

  it("does not use a second generic 401 as proof that the credential was revoked", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "temporary auth failure" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const generation = createCredentialGeneration();
    const onCredentialRejected = vi.fn();
    const client = createStationClient(
      { machineId: "m1", apiKey: "still-valid", serverUrl: "http://localhost:3000" },
      { credentialBoundary: { machineId: "m1", generation, onCredentialRejected } },
    );

    await expect(client.get("/station/operators")).rejects.toEqual(
      new StationApiError(401, "temporary auth failure"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(generation.phase).toBe("active");
    expect(onCredentialRejected).not.toHaveBeenCalled();
  });

  it("keeps the station enrolled when an optional product image download returns 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "image unavailable" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const generation = createCredentialGeneration();
    const onCredentialRejected = vi.fn();
    const client = createStationClient(
      { machineId: "m1", apiKey: "still-valid", serverUrl: "http://localhost:3000" },
      { credentialBoundary: { machineId: "m1", generation, onCredentialRejected } },
    );

    await expect(client.download("/station/products/p1/image/checksum")).rejects.toEqual(
      new StationApiError(401, "image unavailable"),
    );

    expect(generation.phase).toBe("active");
    expect(onCredentialRejected).not.toHaveBeenCalled();
  });

  it("seals the credential when an image download returns explicit revocation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "revoked", code: "STATION_CREDENTIAL_REVOKED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const generation = createCredentialGeneration();
    const onCredentialRejected = vi.fn();
    const client = createStationClient(
      { machineId: "m1", apiKey: "revoked", serverUrl: "http://localhost:3000" },
      { credentialBoundary: { machineId: "m1", generation, onCredentialRejected } },
    );

    await expect(client.download("/station/products/p1/image/checksum")).rejects.toEqual(
      new StationApiError(401, "revoked", "STATION_CREDENTIAL_REVOKED"),
    );

    expect(generation.phase).toBe("sealed");
    expect(onCredentialRejected).toHaveBeenCalledTimes(1);
  });

  it("publishes one rejection when concurrent authenticated requests receive 401", async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );
    const generation = createCredentialGeneration();
    const onCredentialRejected = vi.fn();
    const client = createStationClient(
      { machineId: "m1", apiKey: "revoked", serverUrl: "http://localhost:3000" },
      { credentialBoundary: { machineId: "m1", generation, onCredentialRejected } },
    );
    const first = client.get("/station/operators");
    const second = client.get("/shifts");

    resolveFirst(
      new Response(JSON.stringify({ message: "revoked", code: "STATION_CREDENTIAL_REVOKED" }), {
        status: 401,
      }),
    );
    resolveSecond(
      new Response(JSON.stringify({ message: "revoked", code: "STATION_CREDENTIAL_REVOKED" }), {
        status: 401,
      }),
    );
    const results = await Promise.allSettled([first, second]);

    expect(results).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.any(StationApiError) }),
      expect.objectContaining({ status: "rejected", reason: expect.any(StationApiError) }),
    ]);
    expect(onCredentialRejected).toHaveBeenCalledTimes(1);
    expect(generation.phase).toBe("sealed");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["403", () => Promise.resolve(new Response("forbidden", { status: 403 }))],
    ["429", () => Promise.resolve(new Response("slow down", { status: 429 }))],
    ["503", () => Promise.resolve(new Response("unavailable", { status: 503 }))],
    ["network error", () => Promise.reject(new Error("offline"))],
    ["status-shaped value", () => Promise.reject({ status: 401 })],
    ["abort", () => Promise.reject(new DOMException("aborted", "AbortError"))],
  ])("does not seal an authenticated generation for %s", async (_name, response) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(response);
    const generation = createCredentialGeneration();
    const onCredentialRejected = vi.fn();
    const client = createStationClient(
      { machineId: "m1", apiKey: "still-valid", serverUrl: "http://localhost:3000" },
      { credentialBoundary: { machineId: "m1", generation, onCredentialRejected } },
    );

    await expect(client.get("/shifts")).rejects.toBeDefined();

    expect(generation.phase).toBe("active");
    expect(onCredentialRejected).not.toHaveBeenCalled();
  });

  // Finding 1: a bare `fetch` has no built-in timeout, so a connection that
  // is accepted but whose response never arrives (a swallowed FIN, a captive
  // portal) used to hang the awaiting caller forever. Proves the request now
  // rejects on its own once REQUEST_TIMEOUT_MS elapses, without needing the
  // stalled `fetch` promise to ever settle by itself.
  it("rejects a stalled request once REQUEST_TIMEOUT_MS elapses, without the underlying fetch ever settling", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    // A fetch that never resolves or rejects on its own -- it only reacts to
    // the AbortSignal the client must now pass it, exactly like a real
    // stalled connection reacts only to being aborted, not to time passing.
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const client = createStationClient({
      machineId: "m1",
      apiKey: "mk_key",
      serverUrl: "http://localhost:3000",
    });

    const pending = client.get("/shifts");
    const assertion = expect(pending).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1_000);
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("whoami presence probe", () => {
  const cfg = { machineId: "m1", apiKey: "mk_key", serverUrl: "http://localhost:3000" };
  const HEARTBEAT_URL = "http://localhost:3000/station/heartbeat";
  const LEGACY_PROBE_URL = "http://localhost:3000/shifts?status=active";

  function requestedUrls(fetchMock: { mock: { calls: unknown[][] } }): string[] {
    return fetchMock.mock.calls.map(([url]) => String(url));
  }

  it("asks only the dedicated heartbeat route, with the device key", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const onReachabilityChange = vi.fn();
    const client = createStationClient(cfg, { onReachabilityChange });

    await expect(client.whoami()).resolves.toEqual({ ok: true });

    expect(requestedUrls(fetchMock)).toEqual([HEARTBEAT_URL]);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("mk_key");
    expect(onReachabilityChange.mock.calls).toEqual([["reachable"]]);
  });

  it.each([404, 405])(
    "falls back to the bounded active-shift probe when an older server answers %s",
    async (status) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "Cannot GET /station/heartbeat" }), { status }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      const client = createStationClient(cfg);

      await expect(client.whoami()).resolves.toEqual({ ok: true });

      expect(requestedUrls(fetchMock)).toEqual([HEARTBEAT_URL, LEGACY_PROBE_URL]);
    },
  );

  // A browser never shows the station an older server's 404: that server's
  // CORS policy does not list the new path, so the preflight fails and fetch
  // rejects without any response.
  it("falls back without flashing unreachable when an older server refuses the new route's preflight", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const onReachabilityChange = vi.fn();
    const client = createStationClient(cfg, { onReachabilityChange });

    await expect(client.whoami()).resolves.toEqual({ ok: true });

    expect(requestedUrls(fetchMock)).toEqual([HEARTBEAT_URL, LEGACY_PROBE_URL]);
    expect(onReachabilityChange.mock.calls).toEqual([["reachable"]]);
  });

  it("reports one unreachable result when neither probe reaches the server", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const onReachabilityChange = vi.fn();
    const client = createStationClient(cfg, { onReachabilityChange });

    await expect(client.whoami()).rejects.toBeInstanceOf(TypeError);

    expect(requestedUrls(fetchMock)).toEqual([HEARTBEAT_URL, LEGACY_PROBE_URL]);
    expect(onReachabilityChange.mock.calls).toEqual([["unreachable"]]);
  });

  it.each([
    ["generic 401", 401],
    ["403", 403],
    ["429", 429],
    ["503", 503],
  ])("does not retry through the legacy probe after a server %s", async (_name, status) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ message: "no" }), { status }));
    const client = createStationClient(cfg);

    await expect(client.whoami()).rejects.toEqual(new StationApiError(status, "no"));

    expect(requestedUrls(fetchMock)).toEqual([HEARTBEAT_URL]);
  });

  it("does not stack a second attempt on a heartbeat that timed out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const onReachabilityChange = vi.fn();
    const client = createStationClient(cfg, { onReachabilityChange });

    const pending = client.whoami();
    const assertion = expect(pending).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1_000);
    await assertion;

    expect(requestedUrls(fetchMock)).toEqual([HEARTBEAT_URL]);
    expect(onReachabilityChange.mock.calls).toEqual([["unreachable"]]);
  });

  it("seals the credential generation on explicit revocation without asking the legacy route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "revoked", code: "STATION_CREDENTIAL_REVOKED" }), {
        status: 401,
      }),
    );
    const generation = createCredentialGeneration();
    const onCredentialRejected = vi.fn();
    const client = createStationClient(cfg, {
      credentialBoundary: { machineId: "m1", generation, onCredentialRejected },
    });

    await expect(client.whoami()).rejects.toEqual(
      new StationApiError(401, "revoked", "STATION_CREDENTIAL_REVOKED"),
    );

    expect(requestedUrls(fetchMock)).toEqual([HEARTBEAT_URL]);
    expect(generation.phase).toBe("sealed");
    expect(onCredentialRejected).toHaveBeenCalledTimes(1);
  });

  it("seals the credential generation when an older server revokes it on the legacy probe", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "revoked", code: "STATION_CREDENTIAL_REVOKED" }), {
          status: 401,
        }),
      );
    const generation = createCredentialGeneration();
    const onCredentialRejected = vi.fn();
    const client = createStationClient(cfg, {
      credentialBoundary: { machineId: "m1", generation, onCredentialRejected },
    });

    await expect(client.whoami()).rejects.toEqual(
      new StationApiError(401, "revoked", "STATION_CREDENTIAL_REVOKED"),
    );

    expect(generation.phase).toBe("sealed");
    expect(onCredentialRejected).toHaveBeenCalledTimes(1);
  });
});

describe("redeemStationPairing", () => {
  it("posts the code without an enrolled-device credential", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          device: {
            id: "device-1",
            name: "Line station",
            tenantId: "tenant-1",
            organizationName: "Factory",
            line: { id: "line-1", name: "Packing" },
          },
          credential: { apiKey: "station-credential", serverUrl: "https://station.example" },
          operators: [],
          subscription: {
            access: "managed",
            status: "active",
            startsAt: "2026-08-01T00:00:00.000Z",
            endsAt: "2026-09-01T00:00:00.000Z",
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(redeemStationPairing("https://station.example/", "12345678")).resolves.toEqual({
      ok: true,
      provisioning: expect.objectContaining({
        deviceId: "device-1",
        tenantId: "tenant-1",
        apiKey: "station-credential",
        serverUrl: "https://station.example",
      }),
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://station.example/station/pair");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ code: "12345678" }));
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      "x-station-capabilities":
        "subscription-state-v1,station-recovery-v1,replacement-boundary-v1,replacement-readiness-v1,replacement-evidence-recovery-v1,validation-dm-duplicate-v1,validation-reprocessing-v1",
    });
  });

  it("accepts the exact legacy pairing envelope from an old server", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          device: {
            id: "device-1",
            name: "Line station",
            tenantId: "tenant-1",
            organizationName: "Factory",
            line: null,
          },
          credential: { apiKey: "station-credential", serverUrl: "https://station.example" },
          operators: [],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(redeemStationPairing("https://station.example", "12345678")).resolves.toEqual({
      ok: true,
      provisioning: expect.objectContaining({
        deviceId: "device-1",
        tenantId: "tenant-1",
        apiKey: "station-credential",
      }),
    });
  });

  it("maps pairing error codes without exposing an unauthenticated response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "PAIR_EXPIRED", message: "do not surface this" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(redeemStationPairing("https://station.example", "12345678")).resolves.toEqual({
      ok: false,
      error: "expired",
    });
  });

  it("rejects a malformed provisioning response before it reaches persistence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ credential: { apiKey: "station-credential" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(redeemStationPairing("https://station.example", "12345678")).resolves.toEqual({
      ok: false,
      error: "invalid_response",
    });
  });

  it("rejects plaintext operator verifiers before provisioning can begin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          device: {
            id: "device-1",
            name: "Line station",
            tenantId: "tenant-1",
            organizationName: "Factory",
            line: null,
          },
          credential: { apiKey: "station-credential", serverUrl: "https://station.example" },
          operators: [
            {
              operatorId: "operator-1",
              name: "Operator",
              login: "1001",
              role: "operator",
              pinHash: "not-a-phc",
              badgeHash: null,
              active: true,
            },
          ],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(redeemStationPairing("https://station.example", "12345678")).resolves.toEqual({
      ok: false,
      error: "invalid_response",
    });
  });
});
