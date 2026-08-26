import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, relaunchMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(command: string, payload?: Record<string, unknown>) => Promise<unknown>>(),
  relaunchMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/core", () => {
  class FakeChannel {
    onmessage: (payload: unknown) => void;

    constructor(onmessage: (payload: unknown) => void = () => undefined) {
      this.onmessage = onmessage;
    }
  }

  return {
    Channel: FakeChannel,
    invoke: (command: string, payload?: Record<string, unknown>) => invokeMock(command, payload),
  };
});
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: relaunchMock }));

import { tauriStationUpdater } from "../src/lib/tauri-updater.js";

const candidate = {
  candidateId: "candidate-opaque-1",
  currentVersion: "0.1.0-beta.1",
  version: "0.1.0-beta.2",
  publishedAt: "2026-08-11T00:00:00.000Z",
  selectedOrigin: "github",
  fallbackReason: "primary-unavailable",
};

type FakeProgressChannel = { onmessage(payload: unknown): void };

function mockProgressStream(events: unknown[], result: unknown = null): void {
  invokeMock.mockImplementation(async (command, payload) => {
    if (command === "station_update_check") return candidate;
    if (command === "station_update_download_and_install") {
      const progress = payload?.progress as FakeProgressChannel;
      for (const event of events) progress.onmessage(event);
      return result;
    }
    if (command === "station_update_close") return null;
    throw new Error(`unexpected command: ${command}`);
  });
}

describe("tauri station updater adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses only the three semantic Rust commands and decodes closed progress events", async () => {
    invokeMock.mockImplementation(async (command, payload) => {
      if (command === "station_update_check") return candidate;
      if (command === "station_update_download_and_install") {
        const progress = payload?.progress as { onmessage(payload: unknown): void };
        progress.onmessage({ event: "Started", data: { contentLength: 10 } });
        progress.onmessage({ event: "Progress", data: { chunkLength: 4 } });
        progress.onmessage({
          event: "Fallback",
          data: { from: "yandex", to: "github", reason: "timeout" },
        });
        progress.onmessage({ event: "Progress", data: { chunkLength: 6 } });
        progress.onmessage({ event: "Finished" });
        return null;
      }
      if (command === "station_update_close") return null;
      throw new Error(`unexpected command: ${command}`);
    });

    const update = await tauriStationUpdater.check();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "station_update_check", undefined);
    expect(update).toMatchObject({
      currentVersion: "0.1.0-beta.1",
      version: "0.1.0-beta.2",
      publishedAt: "2026-08-11T00:00:00.000Z",
      origin: "github",
      fallbackReason: "primary-unavailable",
    });

    const events: unknown[] = [];
    await update?.downloadAndInstall((event) => events.push(event));
    expect(events).toEqual([
      { event: "Started", contentLength: 10 },
      { event: "Progress", chunkLength: 4 },
      { event: "Fallback", from: "yandex", to: "github", reason: "timeout" },
      { event: "Progress", chunkLength: 6 },
      { event: "Finished" },
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "station_update_download_and_install", {
      request: { candidateId: "candidate-opaque-1" },
      progress: expect.objectContaining({ onmessage: expect.any(Function) }),
    });

    await update?.close();
    expect(invokeMock).toHaveBeenNthCalledWith(3, "station_update_close", {
      request: { candidateId: "candidate-opaque-1" },
    });
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain("http");
  });

  it("accepts canonical forward stable metadata and primary provenance", async () => {
    invokeMock.mockResolvedValueOnce({
      ...candidate,
      currentVersion: "1.0.0",
      version: "1.1.0",
      selectedOrigin: "yandex",
      fallbackReason: null,
    });

    await expect(tauriStationUpdater.check()).resolves.toMatchObject({
      currentVersion: "1.0.0",
      version: "1.1.0",
      origin: "yandex",
      fallbackReason: null,
    });
  });

  it("accepts GitHub as the primary source for a legacy seed build", async () => {
    invokeMock.mockResolvedValueOnce({
      ...candidate,
      selectedOrigin: "github",
      fallbackReason: null,
    });

    await expect(tauriStationUpdater.check()).resolves.toMatchObject({
      origin: "github",
      fallbackReason: null,
    });
  });

  it("returns null when no update is available", async () => {
    invokeMock.mockResolvedValueOnce(null);
    await expect(tauriStationUpdater.check()).resolves.toBeNull();
  });

  it("strictly rejects malformed result shapes and closes a recoverable candidate", async () => {
    const malformed = [
      { ...candidate, extra: true },
      { ...candidate, candidateId: "" },
      { ...candidate, currentVersion: "0.1.0-beta.1+build" },
      { ...candidate, version: "0.1.0-beta.0" },
      { ...candidate, publishedAt: "2026-08-11T00:00:00Z" },
      { ...candidate, selectedOrigin: "mirror" },
      { ...candidate, selectedOrigin: "yandex", fallbackReason: "primary-unavailable" },
    ];

    for (const value of malformed) {
      invokeMock.mockImplementation(async (command) => {
        if (command === "station_update_check") return value;
        if (command === "station_update_close") return null;
        throw new Error(`unexpected command: ${command}`);
      });
      await expect(tauriStationUpdater.check()).rejects.toThrow(/invalid station update/);
    }

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "station_update_close"),
    ).toHaveLength(6);
  });

  it("rejects unknown progress shapes and cancels the opaque candidate", async () => {
    invokeMock.mockImplementation(async (command, payload) => {
      if (command === "station_update_check") return candidate;
      if (command === "station_update_download_and_install") {
        const progress = payload?.progress as { onmessage(payload: unknown): void };
        progress.onmessage({
          event: "Fallback",
          data: { from: "yandex", to: "github", reason: "network", url: "forbidden" },
        });
        return null;
      }
      if (command === "station_update_close") return null;
      throw new Error(`unexpected command: ${command}`);
    });

    const update = await tauriStationUpdater.check();
    await expect(update?.downloadAndInstall(() => undefined)).rejects.toThrow(
      /invalid station update progress/,
    );
    expect(invokeMock).toHaveBeenCalledWith("station_update_close", {
      request: { candidateId: "candidate-opaque-1" },
    });
  });

  it.each([
    {
      name: "metadata fallback before the first started event",
      events: [
        {
          event: "Fallback",
          data: { from: "yandex", to: "github", reason: "metadata" },
        },
        { event: "Started", data: { contentLength: 10 } },
        { event: "Progress", data: { chunkLength: 10 } },
        { event: "Finished" },
      ],
    },
    {
      name: "fallback after partial primary progress and a peer start",
      events: [
        { event: "Started", data: { contentLength: 10 } },
        { event: "Progress", data: { chunkLength: 4 } },
        {
          event: "Fallback",
          data: { from: "yandex", to: "github", reason: "http" },
        },
        { event: "Started", data: { contentLength: 10 } },
        { event: "Progress", data: { chunkLength: 6 } },
        { event: "Finished" },
      ],
    },
  ])("accepts the real Rust $name sequence", async ({ events }) => {
    mockProgressStream(events);
    const update = await tauriStationUpdater.check();
    const forwarded: unknown[] = [];

    await update?.downloadAndInstall((event) => forwarded.push(event));

    expect(forwarded).toHaveLength(events.length);
    expect(invokeMock.mock.calls.filter(([command]) => command === "station_update_close")).toEqual(
      [],
    );
  });

  it.each([
    {
      name: "progress before start",
      events: [{ event: "Progress", data: { chunkLength: 1 } }],
      forwarded: 0,
    },
    {
      name: "zero announced length",
      events: [{ event: "Started", data: { contentLength: 0 } }],
      forwarded: 0,
    },
    {
      name: "oversized announced length",
      events: [{ event: "Started", data: { contentLength: 512 * 1024 * 1024 + 1 } }],
      forwarded: 0,
    },
    {
      name: "duplicate start in one attempt",
      events: [
        { event: "Started", data: { contentLength: 10 } },
        { event: "Started", data: { contentLength: 10 } },
      ],
      forwarded: 1,
    },
    {
      name: "duplicate fallback",
      events: [
        {
          event: "Fallback",
          data: { from: "yandex", to: "github", reason: "network" },
        },
        {
          event: "Fallback",
          data: { from: "yandex", to: "github", reason: "timeout" },
        },
      ],
      forwarded: 1,
    },
    {
      name: "fallback after the announced package is complete",
      events: [
        { event: "Started", data: { contentLength: 5 } },
        { event: "Progress", data: { chunkLength: 5 } },
        {
          event: "Fallback",
          data: { from: "yandex", to: "github", reason: "network" },
        },
      ],
      forwarded: 2,
    },
    {
      name: "peer start after peer progress",
      events: [
        { event: "Started", data: { contentLength: 10 } },
        { event: "Progress", data: { chunkLength: 4 } },
        {
          event: "Fallback",
          data: { from: "yandex", to: "github", reason: "network" },
        },
        { event: "Progress", data: { chunkLength: 1 } },
        { event: "Started", data: { contentLength: 10 } },
      ],
      forwarded: 4,
    },
    { name: "finish before start", events: [{ event: "Finished" }], forwarded: 0 },
    {
      name: "bytes beyond the announced package length",
      events: [
        { event: "Started", data: { contentLength: 5 } },
        { event: "Progress", data: { chunkLength: 6 } },
      ],
      forwarded: 1,
    },
    {
      name: "duplicate finish",
      events: [
        { event: "Started", data: { contentLength: 1 } },
        { event: "Progress", data: { chunkLength: 1 } },
        { event: "Finished" },
        { event: "Finished" },
      ],
      forwarded: 3,
    },
  ])("rejects the invalid stream: $name", async ({ events, forwarded }) => {
    mockProgressStream([
      ...events,
      { event: "Started", data: { contentLength: 1 } },
      { event: "Progress", data: { chunkLength: 1 } },
      { event: "Finished" },
    ]);
    const update = await tauriStationUpdater.check();
    const callbacks: unknown[] = [];

    await expect(update?.downloadAndInstall((event) => callbacks.push(event))).rejects.toThrow(
      /invalid station update progress/,
    );

    expect(callbacks).toHaveLength(forwarded);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "station_update_close"),
    ).toHaveLength(1);
  });

  it("rejects a resolved Rust command whose stream never finished", async () => {
    mockProgressStream([
      { event: "Started", data: { contentLength: 10 } },
      { event: "Progress", data: { chunkLength: 10 } },
    ]);
    const update = await tauriStationUpdater.check();

    await expect(update?.downloadAndInstall(() => undefined)).rejects.toThrow(
      /invalid station update progress/,
    );
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "station_update_close"),
    ).toHaveLength(1);
  });

  it("decodes only the closed Rust error shape", async () => {
    invokeMock.mockRejectedValueOnce({ code: "origin-mismatch", retryable: false });
    await expect(tauriStationUpdater.check()).rejects.toMatchObject({
      code: "origin-mismatch",
      retryable: false,
    });

    invokeMock.mockRejectedValueOnce({
      code: "origins-unavailable",
      retryable: true,
      detail: "https://forbidden.example",
    });
    await expect(tauriStationUpdater.check()).rejects.toThrow(/invalid station update error/);
  });

  it("delegates explicit relaunch", async () => {
    relaunchMock.mockResolvedValue(undefined);
    await tauriStationUpdater.relaunch();
    expect(relaunchMock).toHaveBeenCalledOnce();
  });
});
