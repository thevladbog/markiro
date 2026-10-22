import { describe, expect, it, vi } from "vitest";

import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { readParticipation } from "../src/floor/shifts/shift-participation.js";
import { rejoinLeftPart } from "../src/floor/shifts/shift-rejoin.js";
import { HostError } from "../src/host/client.js";
import type { EnteredShift, ShiftEnter } from "../src/host/protocol.js";
import { STATION_SHIFT_ENTER } from "../src/host/requests.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import {
  enteredOf,
  OTHER_STATION,
  participant,
  sharedShift,
  STATION_ROW,
  THIRD_STATION,
} from "./support/multi-station.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const NOW = () => new Date("2026-10-08T10:00:05.000Z");

/** The shared shift with this station `left` (token 12) and another station active, at 10:00:00. */
const LEFT_HERE = enteredOf(
  sharedShift({
    participants: [
      { row: { ...participant(DEVICE_ID, "Станция 1", "left"), joinedRev: 12 }, accepted: 4 },
      { row: participant(OTHER_STATION, "Станция 2", "active"), accepted: 3 },
    ],
    myState: "left",
    asOf: "2026-10-08T10:00:00Z",
  }),
);
/** The host's answer to the return: this station active again with a new token, at 10:00:06. */
const BACK: EnteredShift = enteredOf(
  sharedShift({
    participants: [
      { row: { ...STATION_ROW, state: "active", joinedRev: 31 }, accepted: 4 },
      { row: participant(OTHER_STATION, "Станция 2", "active"), accepted: 3 },
    ],
    myState: "active",
    asOf: "2026-10-08T10:00:06Z",
  }),
);

async function kept(shift: EnteredShift = LEFT_HERE) {
  const opened = openLocalDb();
  await keepEnteredShift(opened.executor, PAIRING, shift, "2026-10-08T06:02:00.000Z", 1);
  return opened;
}

function context(
  local: ReturnType<typeof openLocalDb>["executor"],
  enter: (id: string, body: ShiftEnter) => Promise<EnteredShift>,
  online = true,
) {
  return { local, pairing: PAIRING, online, enter, now: NOW };
}

describe("a part the host has as left while this station works it (plan 2b, final review I1)", () => {
  it("enters again on the host and keeps the answer: the part is active with its new token", async () => {
    const { executor } = await kept();
    const enter = vi.fn(async () => BACK);
    expect(await rejoinLeftPart(context(executor, enter), LEFT_HERE.id)).toEqual({
      kind: "rejoined",
    });
    expect(enter).toHaveBeenCalledWith(LEFT_HERE.id, STATION_SHIFT_ENTER);
    const cached = await readParticipation(executor, PAIRING, LEFT_HERE.id);
    expect(cached).toMatchObject({ myState: "active", joinedRev: 31 });
  });

  it("asks nothing of a part that is active, of a pause the operator asked for, or without the link", async () => {
    const active = await kept(BACK);
    const enter = vi.fn(async () => BACK);
    expect(await rejoinLeftPart(context(active.executor, enter), BACK.id)).toEqual({
      kind: "none",
    });
    const paused = await kept();
    paused.db
      .prepare("UPDATE floor_shift_participation SET leave_requested_at = ?")
      .run("2026-10-08T10:00:01.000Z");
    expect(await rejoinLeftPart(context(paused.executor, enter), LEFT_HERE.id)).toEqual({
      kind: "none",
    });
    const offline = await kept();
    expect(await rejoinLeftPart(context(offline.executor, enter, false), LEFT_HERE.id)).toEqual({
      kind: "none",
    });
    // A shift closing here, or closed by the office, takes no new slot.
    const closing = await kept();
    closing.db.prepare("UPDATE floor_shifts SET local_state = 'closing'").run();
    expect(await rejoinLeftPart(context(closing.executor, enter), LEFT_HERE.id)).toEqual({
      kind: "none",
    });
    expect(enter).not.toHaveBeenCalled();
  });

  it("a full line is said with its numbers and changes nothing kept: the line goes on", async () => {
    const { executor } = await kept();
    const enter = vi.fn(async () => {
      throw new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "full",
        details: { constraint: "shift_line_full", active: 2, maxStations: 2 },
      });
    });
    expect(await rejoinLeftPart(context(executor, enter), LEFT_HERE.id)).toEqual({
      kind: "line_full",
      line: { active: 2, maxStations: 2 },
    });
    expect(await readParticipation(executor, PAIRING, LEFT_HERE.id)).toMatchObject({
      myState: "left",
      joinedRev: 12,
    });
  });

  it("a request that found no host is tried again later; a refused key goes to the shell", async () => {
    const { executor } = await kept();
    const away = vi.fn(async () => {
      throw new HostError({ kind: "transport", code: "unreachable", message: "away" });
    });
    expect(await rejoinLeftPart(context(executor, away), LEFT_HERE.id)).toEqual({
      kind: "failed",
    });
    const refusedKey = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "key",
      details: { credential: "device" },
    });
    const rejected = vi.fn(async () => {
      throw refusedKey;
    });
    expect(await rejoinLeftPart(context(executor, rejected), LEFT_HERE.id)).toEqual({
      kind: "rejected",
      error: refusedKey,
    });
  });

  it("a part closed on the host meanwhile is kept as closed and not worked as active", async () => {
    const { executor } = await kept();
    const closed = enteredOf(
      sharedShift({
        participants: [
          { row: participant(DEVICE_ID, "Станция 1", "closed"), accepted: 4 },
          { row: participant(THIRD_STATION, "Станция 3", "active"), accepted: 3 },
        ],
        myState: "closed",
        asOf: "2026-10-08T10:00:06Z",
      }),
    );
    expect(
      await rejoinLeftPart(
        context(executor, async () => closed),
        LEFT_HERE.id,
      ),
    ).toEqual({
      kind: "none",
    });
    expect(await readParticipation(executor, PAIRING, LEFT_HERE.id)).toMatchObject({
      myState: "closed",
    });
  });
});
