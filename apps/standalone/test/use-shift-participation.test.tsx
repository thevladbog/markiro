import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import {
  SHIFT_TOTALS_POLL_MS,
  useShiftParticipation,
} from "../src/floor/work/use-shift-participation.js";
import type { EnteredShift } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import {
  enteredOf,
  SHARED,
  SHARED_ENTERED,
  sharedShift,
  STATION_ROW,
} from "./support/multi-station.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };

async function stationWith(entered: EnteredShift = SHARED_ENTERED): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await keepEnteredShift(executor, PAIRING, entered, "2026-10-08T06:02:00.000Z", 1);
  return executor;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the work screen's figures of a shared shift (plan 2b)", () => {
  it("reads the cache, and reads it again after every read of the host's list", async () => {
    const local = await stationWith();
    const { result, rerender } = renderHook(
      (props: { reads: number }) =>
        useShiftParticipation({
          local,
          pairing: PAIRING,
          shiftId: SHARED.id,
          shiftReads: props.reads,
          online: false,
        }),
      { initialProps: { reads: 0 } },
    );
    await waitFor(() => expect(result.current?.totals.accepted).toBe(547));
    const later = enteredOf(
      sharedShift({
        participants: [{ row: STATION_ROW, accepted: 600 }],
        myState: "active",
        asOf: "2026-10-08T09:50:00Z",
      }),
    );
    await keepEnteredShift(local, PAIRING, later, "2026-10-08T09:50:00.000Z", 2);
    rerender({ reads: 1 });
    await waitFor(() => expect(result.current?.totals.accepted).toBe(600));
  });

  it("asks the link for the list every 15 s while the shift is shared and the link is up, and not without the link", async () => {
    const local = await stationWith();
    const onRefresh = vi.fn();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { result, rerender, unmount } = renderHook(
      (props: { online: boolean }) =>
        useShiftParticipation({
          local,
          pairing: PAIRING,
          shiftId: SHARED.id,
          shiftReads: 0,
          online: props.online,
          onRefresh,
        }),
      { initialProps: { online: true } },
    );
    await vi.waitFor(() => expect(result.current).not.toBeNull());
    act(() => {
      vi.advanceTimersByTime(SHIFT_TOTALS_POLL_MS * 2);
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);
    rerender({ online: false });
    act(() => {
      vi.advanceTimersByTime(SHIFT_TOTALS_POLL_MS * 2);
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("never asks for a solo shift on a line of one", async () => {
    const solo = enteredOf(
      sharedShift({
        participants: [{ row: STATION_ROW, accepted: 5 }],
        maxStations: 1,
        myState: "active",
      }),
    );
    const local = await stationWith(solo);
    const onRefresh = vi.fn();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { result } = renderHook(() =>
      useShiftParticipation({
        local,
        pairing: PAIRING,
        shiftId: solo.id,
        shiftReads: 0,
        online: true,
        onRefresh,
      }),
    );
    await vi.waitFor(() => expect(result.current?.maxStations).toBe(1));
    act(() => {
      vi.advanceTimersByTime(SHIFT_TOTALS_POLL_MS * 3);
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
