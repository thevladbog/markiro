import { readFileSync } from "node:fs";

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { useHostLink } from "../src/app/host-link.js";
import type { ShellAction } from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import { DeviceError } from "../src/host/device.js";
import { LocalDbError } from "../src/local/executor.js";
import {
  deviceShiftsSchema,
  type ChangesResponse,
  type DeviceShift,
  type DeviceStatus,
  type HostStatus,
} from "../src/host/protocol.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const SHIFTS = deviceShiftsSchema.parse(
  JSON.parse(readFileSync(new URL("../proto/fixtures/device-shifts.json", testModuleUrl), "utf8")),
).shifts;
const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const OFFLINE: HostStatus = {
  state: "offline",
  lastContactAt: 1,
  lastError: "unreachable",
  seq: 2,
};

/** The shell's link as the test drives it: `watch` reports "online" at once. */
function fakeConnection(failWatch: boolean) {
  let handlers: ConnectionHandlers | null = null;
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      if (failWatch) throw new Error("no events");
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

const rowSchema = z.object({ id: z.string(), device_id: z.string() });

function link(deviceShifts: () => Promise<DeviceShift[]>, deviceId = DEVICE_ID, failWatch = false) {
  const { db, executor } = openLocalDb();
  const connection = fakeConnection(failWatch);
  const dispatch = vi.fn<(action: ShellAction) => void>();
  const changes = vi.fn(async (): Promise<ChangesResponse> => ({
    hostId: HOST_ID,
    rev: 1,
    hasMore: false,
    items: [],
  }));
  const refresh = vi.fn(async (): Promise<DeviceStatus> => DEVICE_STATUS);
  const hook = renderHook(
    ({ id }) =>
      useHostLink({
        hostId: HOST_ID,
        deviceId: id,
        connection: connection.connection,
        local: executor,
        changes,
        refresh,
        deviceShifts,
        dispatch,
      }),
    { initialProps: { id: deviceId } },
  );
  const copies = () =>
    executor.query("SELECT id, device_id FROM floor_shifts ORDER BY id", [], rowSchema);
  const reads = () =>
    dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "shifts_read");
  return { db, executor, connection, dispatch, refresh, changes, hook, copies, reads };
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

describe("the station's shifts on the link", () => {
  it("are read once the link is watched and after every revision, into this pairing's copies", async () => {
    const deviceShifts = vi.fn(async () => SHIFTS);
    const { connection, copies, reads, hook } = link(deviceShifts);
    await waitFor(() => expect(reads()).toEqual([{ type: "shifts_read", ok: true }]));
    expect(await copies()).toEqual(
      SHIFTS.map((shift) => ({ id: shift.id, device_id: DEVICE_ID })).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
    deviceShifts.mockResolvedValueOnce([]);
    await connection.revision(7);
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(await copies()).toEqual([]);
    expect(deviceShifts).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("are read one at a time: revisions during a read ask for exactly one more", async () => {
    let answer: (shifts: DeviceShift[]) => void = () => undefined;
    const deviceShifts = vi.fn(async () => SHIFTS);
    const { connection, reads, hook } = link(deviceShifts);
    await waitFor(() => expect(reads()).toHaveLength(1));
    deviceShifts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await connection.revision(7);
    await connection.revision(8);
    await connection.revision(9);
    await settle();
    expect(deviceShifts).toHaveBeenCalledTimes(2);
    await act(async () => {
      answer(SHIFTS);
    });
    await waitFor(() => expect(reads()).toHaveLength(3));
    await settle();
    expect(deviceShifts).toHaveBeenCalledTimes(3);
    hook.unmount();
  });

  it("keep the copies and are tried again after 2 s, then 4 s, while the link is online", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const deviceShifts = vi
      .fn<() => Promise<DeviceShift[]>>()
      .mockResolvedValueOnce(SHIFTS)
      .mockRejectedValueOnce(down)
      .mockRejectedValueOnce(down)
      .mockResolvedValue([]);
    const { connection, copies, reads, hook } = link(deviceShifts);
    await waitFor(() => expect(reads()).toHaveLength(1));
    await connection.revision(7);
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(reads()[1]).toEqual({ type: "shifts_read", ok: false });
    expect(await copies()).toHaveLength(2);
    // The clock also runs with real time (`shouldAdvanceTime`): every check
    // keeps 800 ms from the retry it must not reach yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(deviceShifts).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(deviceShifts).toHaveBeenCalledTimes(3));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(deviceShifts).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(reads().at(-1)).toEqual({ type: "shifts_read", ok: true }));
    expect(await copies()).toEqual([]);
    hook.unmount();
  });

  it("drop the retry while the link is down, and are read at once when it is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const deviceShifts = vi
      .fn<() => Promise<DeviceShift[]>>()
      .mockRejectedValueOnce(down)
      .mockResolvedValue(SHIFTS);
    const { connection, reads, hook } = link(deviceShifts);
    await waitFor(() => expect(reads()).toEqual([{ type: "shifts_read", ok: false }]));
    await connection.status(OFFLINE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(deviceShifts).toHaveBeenCalledTimes(1);
    await connection.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(reads().at(-1)).toEqual({ type: "shifts_read", ok: true }));
    expect(deviceShifts).toHaveBeenCalledTimes(2);
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
    const deviceShifts = vi.fn(async (): Promise<DeviceShift[]> => {
      throw refused;
    });
    const { connection, dispatch, refresh, hook } = link(deviceShifts);
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: "device_rejected", reason: "key_rejected" }),
    );
    const refreshes = refresh.mock.calls.length;
    await connection.revision(7);
    await settle();
    expect(deviceShifts).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(refreshes);
    hook.unmount();
  });

  it("write nothing when the answer lands after the pairing changed", async () => {
    let answer: (shifts: DeviceShift[]) => void = () => undefined;
    const deviceShifts = vi.fn(
      () =>
        new Promise<DeviceShift[]>((resolve) => {
          answer = resolve;
        }),
    );
    const { copies, hook, reads } = link(deviceShifts);
    await waitFor(() => expect(deviceShifts).toHaveBeenCalledTimes(1));
    const late = answer;
    deviceShifts.mockResolvedValue([]);
    hook.rerender({ id: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" });
    await waitFor(() => expect(deviceShifts).toHaveBeenCalledTimes(2));
    await act(async () => {
      late(SHIFTS);
    });
    await settle();
    expect(await copies()).toEqual([]);
    expect(reads()).toEqual([{ type: "shifts_read", ok: true }]);
    hook.unmount();
  });
});

describe("the device read on the link", () => {
  it("says so when the office's change could not be saved on this computer", async () => {
    const { dispatch, refresh, hook } = link(async () => []);
    refresh.mockRejectedValue(new DeviceError("storage", "disk full"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "device_not_saved" }));
    hook.unmount();
  });

  it("says nothing of the disk when the read of the device fails for another reason", async () => {
    const { dispatch, refresh, hook } = link(async () => []);
    refresh.mockRejectedValue(new DeviceError("request_failed", "the host failed"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await settle();
    expect(dispatch).not.toHaveBeenCalledWith({ type: "device_not_saved" });
    hook.unmount();
  });
});

describe("a refusal on any path of the link stops the reads of the shifts too", () => {
  it("is a refused key on the device read", async () => {
    const deviceShifts = vi.fn(async () => SHIFTS);
    const { connection, dispatch, refresh, hook, reads } = link(deviceShifts);
    refresh.mockRejectedValue(new DeviceError("key_rejected", "no"));
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: "device_rejected", reason: "key_rejected" }),
    );
    await waitFor(() => expect(reads()).toHaveLength(1));
    await connection.revision(7);
    await settle();
    expect(deviceShifts).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("is a refused key on the reference sync", async () => {
    const deviceShifts = vi.fn(async () => SHIFTS);
    const { connection, dispatch, changes, hook, reads } = link(deviceShifts);
    changes.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "no",
        details: { credential: "device" },
      }),
    );
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: "device_rejected", reason: "key_rejected" }),
    );
    await waitFor(() => expect(reads()).toHaveLength(1));
    await connection.revision(7);
    await settle();
    expect(deviceShifts).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("is another host on the reference sync", async () => {
    const deviceShifts = vi.fn(async () => SHIFTS);
    const { connection, dispatch, changes, hook, reads } = link(deviceShifts);
    changes.mockResolvedValue({
      hostId: "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f",
      rev: 1,
      hasMore: false,
      items: [],
    });
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({
        type: "sync_finished",
        result: { kind: "other_host" },
      }),
    );
    await waitFor(() => expect(reads()).toHaveLength(1));
    await connection.revision(7);
    await settle();
    expect(deviceShifts).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("is a changed certificate on the shifts' own read", async () => {
    const deviceShifts = vi.fn(async (): Promise<DeviceShift[]> => {
      throw new HostError({
        kind: "transport",
        code: "certificate_mismatch",
        message: "another host",
      });
    });
    const { connection, dispatch, hook } = link(deviceShifts);
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: "device_rejected", reason: "host_changed" }),
    );
    await connection.revision(7);
    await settle();
    expect(deviceShifts).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "shifts_read", ok: false });
    hook.unmount();
  });
});

describe("the station's shifts when the link has no events", () => {
  it("are read once on their own, and again on request", async () => {
    const deviceShifts = vi.fn(async () => SHIFTS);
    const { reads, hook } = link(deviceShifts, DEVICE_ID, true);
    await waitFor(() => expect(reads()).toEqual([{ type: "shifts_read", ok: true }]));
    await act(async () => {
      hook.result.current();
    });
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(deviceShifts).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});

describe("the station's shifts when this computer cannot write them", () => {
  it("count as a failed read and keep the copies the station has", async () => {
    const deviceShifts = vi.fn(async () => SHIFTS);
    const { executor, copies, connection, reads, hook } = link(deviceShifts);
    await waitFor(() => expect(reads()).toEqual([{ type: "shifts_read", ok: true }]));
    const before = await copies();
    expect(before).toHaveLength(2);
    vi.spyOn(executor, "transaction").mockRejectedValueOnce(
      new LocalDbError("statement_failed", "disk full"),
    );
    deviceShifts.mockResolvedValueOnce([]);
    await connection.revision(7);
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(reads()[1]).toEqual({ type: "shifts_read", ok: false });
    expect(await copies()).toEqual(before);
    hook.unmount();
  });

  it("are not retried once the link is unmounted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const deviceShifts = vi.fn<() => Promise<DeviceShift[]>>().mockRejectedValue(down);
    const { reads, hook } = link(deviceShifts);
    await waitFor(() => expect(reads()).toEqual([{ type: "shifts_read", ok: false }]));
    hook.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000);
    });
    expect(deviceShifts).toHaveBeenCalledTimes(1);
  });
});
