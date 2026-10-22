import { describe, expect, it } from "vitest";

import type { DeviceRecord, OfficeShift } from "../src/host/protocol.js";
import {
  attentionItems,
  lineCards,
  type AttentionInput,
} from "../src/office/overview/dashboard-model.js";
import { revokedDeviceIds } from "../src/office/shifts/participation.js";
import {
  reasonMissingShifts,
  silentParticipants,
  waitingOnAbsentDevices,
} from "../src/office/overview/overview-model.js";
import {
  ACTIVE,
  HANDHELD_ID,
  LINE_10,
  LINE_2,
  MILK,
  participant,
  PARTICIPANT_B,
  SHARED,
  SHARED_NO_REASON,
  STATION_ID,
} from "./support/shifts.js";

const NOW = Date.parse("2026-10-08T10:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const THREE = { ...LINE_2, maxStations: 3 };

/** `SHARED` with the station silent for 19 minutes and the handheld heard three minutes ago. */
const WORKING: OfficeShift = {
  ...SHARED,
  participants: [participant({ lastSeenAt: ago(19) }), { ...PARTICIPANT_B, lastSeenAt: ago(3) }],
};

const CALM: AttentionInput = {
  conflicts: null,
  devices: null,
  backups: null,
  license: null,
  settings: null,
  idleLines: [],
  nowMs: NOW,
  pcNowMs: NOW,
};

function device(id: string, name: string, lastSeenAt: string | null): DeviceRecord {
  return {
    id,
    kind: "station",
    name,
    lineId: null,
    appVersion: "1.1.0",
    pairedAt: "2026-09-26T09:15:00Z",
    lastSeenAt,
    revokedAt: null,
  };
}

describe("the devices at work on a line's card (plan 2b)", () => {
  it("counts the active participants of the line's shift against the line's limit", () => {
    const card = lineCards([WORKING], [THREE], [MILK], NOW, "2026-10-08").cards[0];
    expect(card?.stations).toEqual({ active: 2, max: 3 });
  });

  it("counts only those that hold a slot: a paused or closed device does not", () => {
    const shift: OfficeShift = {
      ...WORKING,
      participants: [
        participant({ state: "left" }),
        { ...PARTICIPANT_B, state: "closed", closedBy: "device" },
        participant({ deviceId: "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e" }),
      ],
    };
    expect(lineCards([shift], [THREE], [MILK], NOW, "2026-10-08").cards[0]?.stations).toEqual({
      active: 1,
      max: 3,
    });
  });

  it("claims nothing for a line of one, a shift of a host before protocol 7, or a line with no shift", () => {
    expect(lineCards([WORKING], [LINE_2], [MILK], NOW, "2026-10-08").cards[0]?.stations).toBeNull();
    expect(lineCards([ACTIVE], [THREE], [MILK], NOW, "2026-10-08").cards[0]?.stations).toBeNull();
    expect(lineCards([], [THREE], [MILK], NOW, "2026-10-08").cards[0]?.stations).toBeNull();
    expect(
      lineCards([WORKING], [LINE_10], [MILK], NOW, "2026-10-08").cards[0]?.stations,
    ).toBeNull();
  });
});

describe("a participant that has gone silent (the owner's ten minutes)", () => {
  it("lists the active participants of a line of several devices not heard for more than ten minutes, longest first", () => {
    const shift: OfficeShift = {
      ...WORKING,
      participants: [
        participant({ lastSeenAt: ago(19) }),
        { ...PARTICIPANT_B, lastSeenAt: ago(31) },
      ],
    };
    expect(silentParticipants([shift], [THREE], NOW)).toEqual([
      {
        deviceId: HANDHELD_ID,
        name: "ТСД 1",
        shiftId: SHARED.id,
        shiftNumber: "OCT26-004",
        lineName: "Линия 2",
        since: ago(31),
      },
      {
        deviceId: STATION_ID,
        name: "Станция линии 1",
        shiftId: SHARED.id,
        shiftNumber: "OCT26-004",
        lineName: "Линия 2",
        since: ago(19),
      },
    ]);
  });

  it("takes exactly ten minutes as heard, and a millisecond more as silent", () => {
    const inside = { ...WORKING, participants: [participant({ lastSeenAt: ago(10) })] };
    const outside = {
      ...WORKING,
      participants: [participant({ lastSeenAt: new Date(NOW - 600_001).toISOString() })],
    };
    expect(silentParticipants([inside], [THREE], NOW)).toEqual([]);
    expect(silentParticipants([outside], [THREE], NOW)).toHaveLength(1);
  });

  it("leaves out a device that is paused or closed, a closed shift, and a line of one", () => {
    const paused = {
      ...WORKING,
      participants: [participant({ state: "left", lastSeenAt: ago(60) })],
    };
    expect(silentParticipants([paused], [THREE], NOW)).toEqual([]);
    expect(silentParticipants([{ ...WORKING, status: "closed" }], [THREE], NOW)).toEqual([]);
    // A line of one is the old behaviour: its silent station is the device row's, as before.
    expect(silentParticipants([WORKING], [LINE_2], NOW)).toEqual([]);
    expect(silentParticipants([ACTIVE], [THREE], NOW)).toEqual([]);
  });
});

describe("a shift closed without its reason", () => {
  it("lists closed shifts the host marked, and nothing else", () => {
    expect(reasonMissingShifts([SHARED_NO_REASON, SHARED, ACTIVE])).toEqual([
      { shiftId: SHARED_NO_REASON.id, number: "OCT26-004" },
    ]);
    expect(reasonMissingShifts([{ ...SHARED_NO_REASON, status: "active" }])).toEqual([]);
  });
});

describe("«Требует внимания» with several devices (plan 2b)", () => {
  it("lists a silent participant once, in place of the plain silent-device row of the same device, and keeps the others", () => {
    const silent = silentParticipants([WORKING], [THREE], NOW);
    const items = attentionItems({
      ...CALM,
      devices: [
        device(STATION_ID, "Станция линии 1", ago(19)),
        device("5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e", "Склад", ago(47)),
      ],
      silentParticipants: silent,
    });
    expect(items.map((item) => item.id)).toEqual([
      "device-5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e",
      `participant-${SHARED.id}-${STATION_ID}`,
    ]);
    expect(items[1]).toMatchObject({
      kind: "participant_silent",
      severity: "warn",
      to: `/shifts?shift=${SHARED.id}&tab=stations`,
      titleValues: { name: "Станция линии 1", unit: "minutes", count: 19 },
      detailValues: { shift: "OCT26-004", line: "Линия 2" },
    });
  });

  it("lists it for a role that cannot read devices too", () => {
    const items = attentionItems({
      ...CALM,
      devices: null,
      silentParticipants: silentParticipants([WORKING], [THREE], NOW),
    });
    expect(items.map((item) => item.kind)).toEqual(["participant_silent"]);
  });

  it("asks for the reason of a shift closed without one, with the way to its card", () => {
    const [item] = attentionItems({
      ...CALM,
      reasonMissing: reasonMissingShifts([SHARED_NO_REASON]),
    });
    expect(item).toMatchObject({
      kind: "close_reason_missing",
      severity: "warn",
      to: `/shifts?shift=${SHARED_NO_REASON.id}`,
      titleValues: { number: "OCT26-004" },
    });
  });

  it("is as calm as before when it is given neither", () => {
    expect(attentionItems(CALM)).toEqual([]);
  });
});

describe("a revoked device in a shared shift (the host frees its slot)", () => {
  const REVOKED = revokedDeviceIds([
    { id: STATION_ID, revokedAt: "2026-10-08T12:00:00Z" },
    { id: HANDHELD_ID, revokedAt: null },
  ]);

  it("is not counted in «станций в смене: N из M»", () => {
    const card = lineCards([WORKING], [THREE], [MILK], NOW, "2026-10-08", REVOKED).cards[0];
    expect(card?.stations).toEqual({ active: 1, max: 3 });
    // Nothing known of the devices (a technologist, or not yet read): as before.
    expect(lineCards([WORKING], [THREE], [MILK], NOW, "2026-10-08").cards[0]?.stations).toEqual({
      active: 2,
      max: 3,
    });
  });

  it("raises no silent-participant row, while a live silent device still does", () => {
    const shift: OfficeShift = {
      ...WORKING,
      participants: [
        participant({ lastSeenAt: ago(19) }),
        { ...PARTICIPANT_B, lastSeenAt: ago(31) },
      ],
    };
    expect(silentParticipants([shift], [THREE], NOW, REVOKED).map((each) => each.deviceId)).toEqual(
      [HANDHELD_ID],
    );
    expect(silentParticipants([shift], [THREE], NOW)).toHaveLength(2);
  });
});

describe("a shared shift that waits only for a revoked or paused device", () => {
  const REVOKED = revokedDeviceIds([{ id: STATION_ID, revokedAt: "2026-10-08T12:00:00Z" }]);
  const handheldClosed = {
    ...PARTICIPANT_B,
    state: "closed" as const,
    closedBy: "device" as const,
  };
  const waiting: OfficeShift = { ...SHARED, participants: [participant(), handheldClosed] };

  it("lists an active shift whose only open part is a revoked device's", () => {
    expect(waitingOnAbsentDevices([waiting], REVOKED)).toEqual([
      { shiftId: SHARED.id, number: "OCT26-004" },
    ]);
  });

  it("lists it when the open parts are paused ones, even while the devices list is unread", () => {
    const paused: OfficeShift = {
      ...SHARED,
      participants: [participant({ state: "left" }), handheldClosed],
    };
    expect(waitingOnAbsentDevices([paused])).toEqual([{ shiftId: SHARED.id, number: "OCT26-004" }]);
  });

  it("says nothing while a live active part remains, or when nothing is open, or for a closed shift", () => {
    expect(waitingOnAbsentDevices([SHARED], REVOKED)).toEqual([]);
    expect(waitingOnAbsentDevices([waiting])).toEqual([]);
    expect(waitingOnAbsentDevices([SHARED_NO_REASON], REVOKED)).toEqual([]);
    expect(waitingOnAbsentDevices([{ ...waiting, status: "closed" }], REVOKED)).toEqual([]);
    expect(waitingOnAbsentDevices([ACTIVE], REVOKED)).toEqual([]);
  });

  it("leaves alone a lone station that paused (no device is revoked, nobody else is in)", () => {
    const alone: OfficeShift = { ...ACTIVE, participants: [participant({ state: "left" })] };
    expect(waitingOnAbsentDevices([alone])).toEqual([]);
    expect(waitingOnAbsentDevices([alone], REVOKED)).toHaveLength(1);
  });

  it("becomes an attention row with the way to the card's «Станции»", () => {
    const [item] = attentionItems({
      ...CALM,
      waitingShifts: waitingOnAbsentDevices([waiting], REVOKED),
    });
    expect(item).toMatchObject({
      id: `shift-waits-${SHARED.id}`,
      kind: "shift_waits",
      severity: "warn",
      to: `/shifts?shift=${SHARED.id}&tab=stations`,
      titleValues: { number: "OCT26-004" },
    });
  });
});
