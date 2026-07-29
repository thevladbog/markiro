import { afterEach, describe, expect, it, vi } from "vitest";
import { createStationClient, REQUEST_TIMEOUT_MS } from "../src/lib/api-client.js";

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
