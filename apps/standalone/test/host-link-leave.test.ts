import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { useHostLink } from "../src/app/host-link.js";
import type { ShellAction } from "../src/app/shell.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { markLeave } from "../src/floor/shifts/shift-participation.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import {
  deviceShiftSchema,
  type ChangesResponse,
  type DeviceShift,
  type DeviceStatus,
  type HostStatus,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import type { LeaveShift } from "../src/local/leave-sender.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import {
  enteredOf,
  HANDHELD,
  participant,
  SHARED,
  SHARED_ENTERED,
  sharedShift,
  STATION_ROW,
} from "./support/multi-station.js";

const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const pauseRow = z.object({ leave_requested_at: z.string().nullable() });
const LEFT: DeviceShift = deviceShiftSchema.parse({
  ...SHARED,
  myState: "left",
  totals: { accepted: 547, boxesClosed: 45, pallets: 0, asOf: "2026-10-08T10:00:06Z" },
});

/** The host's answer to an entry after the pause: this station active again, read at 10:11. */
const REENTERED = enteredOf(
  sharedShift({
    participants: [
      { row: STATION_ROW, accepted: 427 },
      { row: participant(HANDHELD, "ТСД 1", "closed", "handheld"), accepted: 120 },
    ],
    myState: "active",
    asOf: "2026-10-08T10:11:00Z",
  }),
);

async function pausedStation(): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await keepEnteredShift(executor, PAIRING, SHARED_ENTERED, "2026-10-08T06:02:00.000Z", 1);
  expect(await markLeave(executor, PAIRING, SHARED.id, "2026-10-08T10:00:00.000Z")).toBe(true);
  return executor;
}

function link(local: LocalExecutor, leaveShift: LeaveShift) {
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      next.onStatus(ONLINE);
      return () => undefined;
    }),
  };
  const deviceShifts = vi.fn(async (): Promise<DeviceShift[]> => [SHARED]);
  const dispatch = vi.fn<(action: ShellAction) => void>();
  const changes = async (): Promise<ChangesResponse> => ({
    hostId: HOST_ID,
    rev: 1,
    hasMore: false,
    items: [],
  });
  const refresh = async (): Promise<DeviceStatus> => DEVICE_STATUS;
  const hook = renderHook(() =>
    useHostLink({
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      connection,
      local,
      changes,
      refresh,
      deviceShifts,
      sendFacts: async () => [],
      registerKnownBlocks: async () => ({ results: [] }),
      leaveShift,
      dispatch,
    }),
  );
  return { hook, deviceShifts };
}

const pauses = (local: LocalExecutor) =>
  local.query("SELECT leave_requested_at FROM floor_shift_participation", [], pauseRow);

describe("the pauses and the list on the link (plan 2b)", () => {
  it("sends a pause the station owes once the link is online, and reads the list again after it", async () => {
    const local = await pausedStation();
    const leaveShift = vi.fn(async () => LEFT);
    const { hook, deviceShifts } = link(local, leaveShift);
    await waitFor(() => expect(leaveShift).toHaveBeenCalledWith(SHARED.id, { joinedRev: 12 }));
    await waitFor(async () => expect(await pauses(local)).toEqual([{ leave_requested_at: null }]));
    // The everything() read, then the one the settled pause asked for.
    await waitFor(() => expect(deviceShifts.mock.calls.length).toBeGreaterThanOrEqual(2));
    hook.unmount();
  });

  it("reads the list and sends a pause at once when a screen asks", async () => {
    const local = await pausedStation();
    const leaveShift = vi.fn(async () => LEFT);
    const { hook, deviceShifts } = link(local, leaveShift);
    await waitFor(() => expect(leaveShift).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await pauses(local)).toEqual([{ leave_requested_at: null }]));
    const reads = deviceShifts.mock.calls.length;
    await act(async () => {
      hook.result.current.requestShifts();
    });
    await waitFor(() => expect(deviceShifts.mock.calls.length).toBeGreaterThan(reads));
    // The station enters again (the host's newer answer: active) and leaves again: the screen
    // asks, and the pause goes at once.
    await keepEnteredShift(local, PAIRING, REENTERED, "2026-10-08T10:11:00.000Z", 2);
    expect(await markLeave(local, PAIRING, SHARED.id, "2026-10-08T10:12:00.000Z")).toBe(true);
    await act(async () => {
      hook.result.current.requestLeaves();
    });
    await waitFor(() => expect(leaveShift).toHaveBeenCalledTimes(2));
    hook.unmount();
  });
});
