import { describe, expect, it, vi } from "vitest";

import {
  createTauriConnectionApi,
  HOST_REVISION_EVENT,
  HOST_STATUS_EVENT,
} from "../src/host/connection.js";
import type { HostStatus } from "../src/host/protocol.js";

type Handler = (event: { payload: unknown }) => void;

/** A fake `listen`: records handlers so the test can emit shell events. */
function fakeEvents() {
  const handlers = new Map<string, Handler>();
  const order: string[] = [];
  const listen = vi.fn(async (event: string, handler: Handler) => {
    order.push(`listen ${event}`);
    handlers.set(event, handler);
    return () => {
      handlers.delete(event);
    };
  });
  const emit = (event: string, payload: unknown) => handlers.get(event)?.({ payload });
  return { listen, emit, handlers, order };
}

function status(seq: number, state: HostStatus["state"] = "online"): HostStatus {
  return {
    state,
    lastContactAt: state === "online" ? 1_700_000_000_000 : null,
    lastError: state === "offline" ? "unreachable" : null,
    seq,
  };
}

describe("connection to the host", () => {
  it("subscribes to both events before asking for the current status", async () => {
    const events = fakeEvents();
    const call = vi.fn(async (command: string) => {
      events.order.push(command);
      return status(1);
    });
    const onStatus = vi.fn();
    await createTauriConnectionApi(call, events.listen).watch({ onStatus, onRevision: vi.fn() });
    expect(events.order).toEqual([
      `listen ${HOST_STATUS_EVENT}`,
      `listen ${HOST_REVISION_EVENT}`,
      "connection_status",
    ]);
    expect(call).toHaveBeenCalledWith("connection_status", {});
    expect(onStatus).toHaveBeenCalledWith(status(1));
  });

  it("keeps only statuses newer than the newest seen", async () => {
    const events = fakeEvents();
    const onStatus = vi.fn();
    // The shell published seq 3 while the snapshot (seq 2) was on its way.
    const call = vi.fn(async () => {
      events.emit(HOST_STATUS_EVENT, status(3, "offline"));
      return status(2);
    });
    await createTauriConnectionApi(call, events.listen).watch({ onStatus, onRevision: vi.fn() });
    events.emit(HOST_STATUS_EVENT, status(3, "online"));
    events.emit(HOST_STATUS_EVENT, status(4, "connecting"));
    expect(onStatus.mock.calls).toEqual([[status(3, "offline")], [status(4, "connecting")]]);
  });

  it("passes revisions on and ignores events it cannot read", async () => {
    const events = fakeEvents();
    const onStatus = vi.fn();
    const onRevision = vi.fn();
    await createTauriConnectionApi(async () => status(1), events.listen).watch({
      onStatus,
      onRevision,
    });
    events.emit(HOST_REVISION_EVENT, { rev: 7 });
    events.emit(HOST_REVISION_EVENT, { rev: -1 });
    events.emit(HOST_REVISION_EVENT, { rev: 8, extra: true });
    events.emit(HOST_STATUS_EVENT, { ...status(5), state: "sleeping" });
    expect(onRevision.mock.calls).toEqual([[7]]);
    expect(onStatus.mock.calls).toEqual([[status(1)]]);
  });

  it("passes on the restore epoch the shell read from the host's hello, and drops a malformed one", async () => {
    // `restoreEpoch` of `proto/fixtures/hello-restored.json`.
    const epoch = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    const events = fakeEvents();
    const onStatus = vi.fn();
    await createTauriConnectionApi(async () => status(1), events.listen).watch({
      onStatus,
      onRevision: vi.fn(),
    });
    events.emit(HOST_STATUS_EVENT, { ...status(2), restoreEpoch: epoch });
    events.emit(HOST_STATUS_EVENT, { ...status(3), restoreEpoch: "epoch-1" });
    events.emit(HOST_STATUS_EVENT, { ...status(4), restoreEpoch: null });
    expect(onStatus.mock.calls).toEqual([[status(1)], [{ ...status(2), restoreEpoch: epoch }]]);
  });

  it("stops listening when asked", async () => {
    const events = fakeEvents();
    const stop = await createTauriConnectionApi(async () => status(1), events.listen).watch({
      onStatus: vi.fn(),
      onRevision: vi.fn(),
    });
    expect(events.handlers.size).toBe(2);
    stop();
    expect(events.handlers.size).toBe(0);
  });

  it("stops listening and fails when the snapshot cannot be read", async () => {
    const events = fakeEvents();
    const watching = createTauriConnectionApi(
      async () => ({ ...status(1), extra: true }),
      events.listen,
    ).watch({ onStatus: vi.fn(), onRevision: vi.fn() });
    await expect(watching).rejects.toThrow();
    expect(events.handlers.size).toBe(0);
  });
});
