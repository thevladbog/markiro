import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { keepEnteredShift, replaceShiftCopies } from "../src/floor/shifts/shift-copies.js";
import {
  activeOthers,
  closesShift,
  participantsEver,
  participationFromShift,
  readParticipation,
  readParticipations,
  sharedCount,
  sharedParticipation,
  UPSERT_PARTICIPATION_SQL,
} from "../src/floor/shifts/shift-participation.js";
import { deviceShiftsSchema } from "../src/host/protocol.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import {
  HANDHELD,
  OTHER_STATION,
  participant,
  SHARED,
  SHARED_ENTERED,
  sharedShift,
  STATION_ROW,
} from "./support/multi-station.js";
import { fixture } from "./support/proto-fixture.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const SEEN = 1_790_000_000_000;
const testModuleUrl = import.meta.url;

describe("the participation cache (plan 2b, migration 0022)", () => {
  it("keeps what the host's list says of a shared shift and reads it back as sent", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [SHARED], SEEN);
    const read = await readParticipation(executor, PAIRING, SHARED.id);
    expect(read).toEqual(participationFromShift(SHARED, DEVICE_ID));
    expect(read).toMatchObject({
      maxStations: 2,
      myState: "active",
      asOf: "2026-10-08T09:41:07Z",
      leaveRequestedAt: null,
      // This station's own leave token, from its participant row (`device-shifts-participants.json`).
      joinedRev: 12,
    });
    expect(read?.participants.map((row) => row.deviceId)).toEqual([DEVICE_ID, HANDHELD]);
  });

  it("keeps nothing of a planned shift or of a host before protocol 7", async () => {
    const { executor } = openLocalDb();
    const old = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts;
    await replaceShiftCopies(executor, PAIRING, old, SEEN);
    expect((await readParticipations(executor, PAIRING)).size).toBe(0);
    expect(participationFromShift(old[0] ?? SHARED, DEVICE_ID)).toBeNull();
  });

  it("takes a closed shift's participants and state from the list and keeps the figures it had (host 35020185a)", async () => {
    const { executor } = openLocalDb();
    // The host's list names a closed shift without `totals`/`byDevice` (its second item): with no
    // row kept for it, none is made — there are no figures to show, and never zeros.
    const listed = deviceShiftsSchema.parse(fixture("device-shifts-participants.json")).shifts;
    const closedFirstSeen = listed[1];
    if (closedFirstSeen === undefined) throw new Error("the fixture has no closed shift");
    expect(closedFirstSeen.totals).toBeUndefined();
    await replaceShiftCopies(executor, PAIRING, [closedFirstSeen], SEEN);
    expect(await readParticipation(executor, PAIRING, closedFirstSeen.id)).toBeNull();
    expect(participationFromShift(closedFirstSeen, DEVICE_ID)).toBeNull();

    // A shift the station saw active is listed closed later: participants and state are taken,
    // the figures of the last answer that had them stay, and so does the leave token.
    await replaceShiftCopies(executor, PAIRING, [SHARED], SEEN);
    const closed = sharedShift({
      participants: [
        { row: participant(DEVICE_ID, "Станция линии 1", "closed"), accepted: 0 },
        { row: participant(HANDHELD, "ТСД 1", "closed", "handheld"), accepted: 0 },
      ],
      myState: "closed",
    });
    delete closed.totals;
    delete closed.byDevice;
    await replaceShiftCopies(
      executor,
      PAIRING,
      [{ ...closed, status: "closed", closedAt: "2026-10-08T15:00:00Z" }],
      SEEN + 1,
    );
    const read = await readParticipation(executor, PAIRING, SHARED.id);
    expect(read).toMatchObject({
      myState: "closed",
      totals: { accepted: 547, asOf: "2026-10-08T09:41:07Z" },
      asOf: "2026-10-08T09:41:07Z",
      joinedRev: 12,
    });
    expect(read?.byDevice.map((part) => part.accepted)).toEqual([427, 120]);
    expect(read?.participants.map((row) => row.state)).toEqual(["closed", "closed"]);
  });

  it("never takes an older read over a newer one, and takes a newer one", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [SHARED], SEEN);
    const older = sharedShift({
      participants: [{ row: STATION_ROW, accepted: 1 }],
      asOf: "2026-10-08T09:40:00Z",
      myState: "active",
    });
    await replaceShiftCopies(executor, PAIRING, [older], SEEN + 1);
    expect((await readParticipation(executor, PAIRING, SHARED.id))?.totals.accepted).toBe(547);
    const newer = sharedShift({
      participants: [{ row: STATION_ROW, accepted: 600 }],
      asOf: "2026-10-08T09:42:00Z",
      myState: "active",
    });
    await replaceShiftCopies(executor, PAIRING, [newer], SEEN + 2);
    expect(await readParticipation(executor, PAIRING, SHARED.id)).toMatchObject({
      asOf: "2026-10-08T09:42:00Z",
      totals: { accepted: 600 },
    });
    // A host clock set back cannot freeze the figures: a read a minute later by this computer's
    // clock is taken whatever its `asOf`.
    const setBack = sharedShift({
      participants: [{ row: STATION_ROW, accepted: 7 }],
      asOf: "2026-10-08T08:00:00Z",
      myState: "active",
    });
    await replaceShiftCopies(executor, PAIRING, [setBack], SEEN + 2 + 60_000);
    expect(await readParticipation(executor, PAIRING, SHARED.id)).toMatchObject({
      asOf: "2026-10-08T08:00:00Z",
      totals: { accepted: 7 },
    });
  });

  it("takes a read a minute later by this computer's clock even when its asOf is older (the clock-set-back override, at the edge)", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [SHARED], SEEN);
    const older = sharedShift({
      participants: [{ row: STATION_ROW, accepted: 3 }],
      asOf: "2026-10-08T07:00:00Z",
      myState: "active",
    });
    // 59999 ms later: still refused; 60001 ms later: taken, though its asOf is older.
    await replaceShiftCopies(executor, PAIRING, [older], SEEN + 59_999);
    expect((await readParticipation(executor, PAIRING, SHARED.id))?.totals.accepted).toBe(547);
    await replaceShiftCopies(executor, PAIRING, [older], SEEN + 60_001);
    expect(await readParticipation(executor, PAIRING, SHARED.id)).toMatchObject({
      asOf: "2026-10-08T07:00:00Z",
      totals: { accepted: 3 },
    });
  });

  it("drops the figures of a shift the station no longer keeps", async () => {
    const { executor } = openLocalDb();
    const joinable = sharedShift({
      participants: [{ row: participant(OTHER_STATION, "Станция линии 2", "active"), accepted: 9 }],
      ownerDeviceId: OTHER_STATION,
    });
    await replaceShiftCopies(executor, PAIRING, [joinable], SEEN);
    expect((await readParticipations(executor, PAIRING)).size).toBe(1);
    await replaceShiftCopies(executor, PAIRING, [], SEEN + 1);
    expect((await readParticipations(executor, PAIRING)).size).toBe(0);
  });

  it("takes an entry's figures and drops a pause the station asked for, so a late pause never undoes it", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, SHARED_ENTERED, "2026-10-08T06:02:00.000Z", SEEN);
    db.prepare("UPDATE floor_shift_participation SET leave_requested_at = ?").run(
      "2026-10-08T10:00:00.000Z",
    );
    expect((await readParticipation(executor, PAIRING, SHARED.id))?.leaveRequestedAt).toBe(
      "2026-10-08T10:00:00.000Z",
    );
    await keepEnteredShift(executor, PAIRING, SHARED_ENTERED, "2026-10-08T10:01:00.000Z", SEEN + 1);
    expect(await readParticipation(executor, PAIRING, SHARED.id)).toMatchObject({
      myState: "active",
      leaveRequestedAt: null,
    });
  });

  it("reads an unreadable row as none, never as a guess", async () => {
    const { db, executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [SHARED], SEEN);
    db.prepare("UPDATE floor_shift_participation SET participants = '[{\"deviceId\":1}]'").run();
    expect(await readParticipation(executor, PAIRING, SHARED.id)).toBeNull();
    expect((await readParticipations(executor, PAIRING)).size).toBe(0);
  });

  it("derives who works the shift, whether this close is the last, and the whole shift's count", () => {
    const shared = participationFromShift(SHARED, DEVICE_ID);
    expect(shared).not.toBeNull();
    if (shared === null) return;
    expect(sharedParticipation(shared)).toBe(shared);
    expect(activeOthers(shared, DEVICE_ID)).toEqual([]);
    expect(closesShift(shared, DEVICE_ID)).toBe(true);
    expect(participantsEver(shared)).toBe(2);
    // The others' part by the host (547 − 427) and this station's own 430 codes.
    expect(sharedCount(shared, DEVICE_ID, 430)).toEqual({
      mine: 430,
      total: 550,
      asOf: "2026-10-08T09:41:07Z",
    });
    const busy = participationFromShift(
      sharedShift({
        participants: [
          { row: STATION_ROW, accepted: 5 },
          { row: participant(OTHER_STATION, "Станция линии 2", "active"), accepted: 7 },
        ],
        myState: "active",
      }),
      DEVICE_ID,
    );
    expect(busy === null ? null : closesShift(busy, DEVICE_ID)).toBe(false);
    expect(busy === null ? [] : activeOthers(busy, DEVICE_ID).map((row) => row.deviceId)).toEqual([
      OTHER_STATION,
    ]);
    // A line of one with this station alone is no shared shift (stage 2a's floor).
    const solo = participationFromShift(
      sharedShift({
        participants: [{ row: STATION_ROW, accepted: 5 }],
        maxStations: 1,
        myState: "active",
      }),
      DEVICE_ID,
    );
    expect(sharedParticipation(solo)).toBeNull();
    expect(participantsEver(null)).toBe(1);
  });

  it("is the very statement the shell's own SQLite runs in src-tauri/tests/local_db.rs", () => {
    const source = readFileSync(new URL("../src-tauri/tests/local_db.rs", testModuleUrl), "utf8")
      // A line continuation of a Rust string drops the newline and the next line's indent.
      .replace(/\\\n\s*/g, "");
    expect(source).toContain(UPSERT_PARTICIPATION_SQL);
  });
});
