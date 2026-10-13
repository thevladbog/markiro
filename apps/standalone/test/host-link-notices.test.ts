import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHostLink } from "../src/app/host-link.js";
import type { ShellAction } from "../src/app/shell.js";
import type { HostApi } from "../src/host/api.js";
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import type { ChangesResponse, DeviceStatus, HostStatus } from "../src/host/protocol.js";
import type { DeviceDisplacements } from "../src/host/review.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const OFFLINE: HostStatus = {
  state: "offline",
  lastContactAt: 1,
  lastError: "unreachable",
  seq: 2,
};
const NONE: DeviceDisplacements = { items: [], more: false };
const DISPLACED: DeviceDisplacements = {
  items: [
    {
      conflictId: "c0000000-0000-4000-8000-000000000001",
      recordId: "00000000-0000-4000-8000-000000000002",
      shiftId: "5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d",
      shiftNumber: "OCT26-004",
      codeHash: "0".repeat(63) + "7",
      boxId: null,
      boxSscc: null,
      detectedAt: "2026-10-08T07:12:03Z",
      winner: {
        shiftId: "6b1d0f2f-4e5a-4c9b-8d3e-2f1a0b9c8d7e",
        shiftNumber: "OCT26-005/S",
        deviceId: "8d0f7780-8536-41ef-a55c-f18a2c3d4e5f",
        scannedAt: "2026-10-08T06:00:50.000Z",
        sameDevice: false,
      },
      reviewedAt: null,
    },
  ],
  more: false,
};

/** The shell's link as the test drives it: `watch` reports "online" at once. */
function fakeConnection() {
  let handlers: ConnectionHandlers | null = null;
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      handlers = next;
      next.onStatus(ONLINE);
      return () => {
        handlers = null;
      };
    }),
  };
  return {
    connection,
    status: (status: HostStatus) =>
      act(async () => {
        handlers?.onStatus(status);
      }),
    revision: (rev: number) =>
      act(async () => {
        handlers?.onRevision(rev);
      }),
  };
}

function link(
  listDisplacements: HostApi["listDisplacements"] | undefined,
  conflictStatus: HostApi["conflictStatus"] | undefined = vi.fn(async () => ({ reviewed: [] })),
) {
  const { db, executor } = openLocalDb();
  const connection = fakeConnection();
  const dispatch = vi.fn<(action: ShellAction) => void>();
  const changes = vi.fn(async (): Promise<ChangesResponse> => ({
    hostId: HOST_ID,
    rev: 1,
    hasMore: false,
    items: [],
  }));
  const refresh = vi.fn(async (): Promise<DeviceStatus> => DEVICE_STATUS);
  const hook = renderHook(() =>
    useHostLink({
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      connection: connection.connection,
      local: executor,
      changes,
      refresh,
      deviceShifts: async () => [],
      sendFacts: async () => [],
      registerKnownBlocks: async () => ({ results: [] }),
      ...(conflictStatus === undefined ? {} : { conflictStatus }),
      ...(listDisplacements === undefined ? {} : { listDisplacements }),
      dispatch,
    }),
  );
  const changed = () =>
    dispatch.mock.calls.filter(([action]) => action.type === "outbox_changed").length;
  return { db, connection, dispatch, refresh, hook, changed };
}

/** Two turns of React's effect scheduler and the promises they started. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the conflict notices on the link (plan КНФ)", () => {
  it("are read once the link is watched and after every revision; what they keep refreshes the outbox's counts", async () => {
    const list = vi
      .fn<HostApi["listDisplacements"]>()
      .mockResolvedValueOnce(DISPLACED)
      .mockResolvedValue(NONE);
    const { connection, hook, changed, db } = link(list);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(changed()).toBe(1));
    expect(db.prepare("SELECT count(*) AS n FROM floor_displacements").get()).toEqual({ n: 1 });
    await connection.revision(7);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await settle();
    // Nothing new: the counts are not read again.
    expect(changed()).toBe(1);
    hook.unmount();
  });

  it("are tried again after 2 s while the link is online, and at once when it comes back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const list = vi
      .fn<HostApi["listDisplacements"]>()
      .mockRejectedValueOnce(down)
      .mockRejectedValueOnce(down)
      .mockResolvedValue(NONE);
    const { connection, hook } = link(list);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    // The link goes down: the retry is dropped; back online, the read runs at once.
    await connection.status(OFFLINE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(list).toHaveBeenCalledTimes(2);
    await connection.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    hook.unmount();
  });

  it("refuse the device on a refused key, and nothing more is read", async () => {
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const list = vi.fn<HostApi["listDisplacements"]>(async () => Promise.reject(refused));
    const { connection, dispatch, hook } = link(list);
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: "device_rejected", reason: "key_rejected" }),
    );
    await connection.revision(7);
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("are not read without the host's two calls", async () => {
    const status = vi.fn<HostApi["conflictStatus"]>(async () => ({ reviewed: [] }));
    const { refresh, hook } = link(undefined, status);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await settle();
    expect(status).not.toHaveBeenCalled();
    hook.unmount();
  });
});
