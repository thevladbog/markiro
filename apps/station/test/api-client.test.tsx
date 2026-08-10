import { afterEach, describe, expect, it, vi } from "vitest";
import { createStationClient, REQUEST_TIMEOUT_MS, StationApiError } from "../src/lib/api-client.js";
import {
  acquireCredentialCommitLease,
  createCredentialGeneration,
} from "../src/lib/credential-recovery.js";
import { redeemStationPairing } from "../src/lib/pairing.js";

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
    const client = createStationClient({
      machineId: "m1",
      tenantId: "org_1",
      apiKey: "mk_key",
      serverUrl: "http://localhost:3000",
    });

    await client.get("/shifts");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:3000/shifts");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("mk_key");
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

  it("seals an authenticated generation before rejecting the original 401 and blocks new requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "revoked" }), {
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
    await expect(rejected).rejects.toEqual(new StationApiError(401, "revoked"));
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

    resolveFirst(new Response(JSON.stringify({ message: "revoked" }), { status: 401 }));
    resolveSecond(new Response(JSON.stringify({ message: "revoked" }), { status: 401 }));
    const results = await Promise.allSettled([first, second]);

    expect(results).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.any(StationApiError) }),
      expect.objectContaining({ status: "rejected", reason: expect.any(StationApiError) }),
    ]);
    expect(onCredentialRejected).toHaveBeenCalledTimes(1);
    expect(generation.phase).toBe("sealed");
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
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
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
