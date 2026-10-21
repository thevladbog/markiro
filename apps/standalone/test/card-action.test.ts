import { describe, expect, it } from "vitest";

import { cardAction } from "../src/floor/shifts/ShiftCard.js";
import type { ShiftCopy } from "../src/floor/shifts/shift-copies.js";
import type { ShiftParticipant } from "../src/host/protocol.js";
import {
  participationFromShift,
  type Participation,
} from "../src/floor/shifts/shift-participation.js";
import { HANDHELD, participant, sharedShift } from "./support/multi-station.js";

const DEVICE = "7c1a2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

function copy(patch: Partial<ShiftCopy>): ShiftCopy {
  return {
    status: "planned",
    localState: null,
    ownerDeviceId: null,
    entered: false,
    ...patch,
  } as ShiftCopy;
}

describe("a shift card's action while the license opens no new shift (plan ЛЦ-3)", () => {
  it("explains a planned shift and nothing else: the open shift of this station goes on", () => {
    expect(cardAction(copy({}), DEVICE, true, "license_restricted")).toEqual({
      kind: "blocked",
      refusal: "license_restricted",
    });
    expect(
      cardAction(
        copy({ status: "active", ownerDeviceId: DEVICE }),
        DEVICE,
        false,
        "license_restricted",
      ),
    ).toEqual({ kind: "continue", enabled: false });
    expect(
      cardAction(
        copy({ status: "active", ownerDeviceId: DEVICE, entered: true }),
        DEVICE,
        false,
        "license_trial_expired",
      ),
    ).toEqual({ kind: "continue", enabled: true });
    expect(
      cardAction(
        copy({ status: "active", ownerDeviceId: OTHER }),
        DEVICE,
        true,
        "license_inn_mismatch",
      ),
    ).toEqual({ kind: "busy" });
    expect(cardAction(copy({ status: "closed" }), DEVICE, true, "license_restricted")).toEqual({
      kind: "finish",
    });
    expect(cardAction(copy({ localState: "closing" }), DEVICE, true, "license_restricted")).toEqual(
      {
        kind: "closing",
      },
    );
  });

  it("opens a planned shift as before without a refusal", () => {
    expect(cardAction(copy({}), DEVICE, true)).toEqual({ kind: "open", enabled: true });
    expect(cardAction(copy({}), DEVICE, false, null)).toEqual({ kind: "open", enabled: false });
  });
});

describe("a shift card's action on a shift several devices work (plan 2b)", () => {
  const working = (deviceId: string, state: ShiftParticipant["state"] = "active") => ({
    row: participant(deviceId, deviceId === DEVICE ? "Эта станция" : "Станция линии 2", state),
    accepted: 10,
  });
  const figures = (
    rows: { row: ShiftParticipant; accepted: number }[],
    maxStations = 2,
    myState: ShiftParticipant["state"] | null = null,
  ): Participation | null =>
    participationFromShift(sharedShift({ participants: rows, maxStations, myState }), DEVICE);
  const active = (patch: Partial<ShiftCopy> = {}) =>
    copy({ status: "active", ownerDeviceId: OTHER, ...patch });

  it("offers to join while a slot is free, needs the link for it, and is no new shift for the license", () => {
    const one = figures([working(OTHER)]);
    expect(cardAction(active(), DEVICE, true, null, one)).toEqual({ kind: "join", enabled: true });
    expect(cardAction(active(), DEVICE, false, null, one)).toEqual({
      kind: "join",
      enabled: false,
    });
    expect(cardAction(active(), DEVICE, true, "license_restricted", one)).toEqual({
      kind: "join",
      enabled: true,
    });
  });

  it("says the line is full when every slot is held by the other devices", () => {
    const full = figures([
      working(OTHER),
      { row: participant(HANDHELD, "ТСД 1", "active", "handheld"), accepted: 3 },
    ]);
    expect(cardAction(active(), DEVICE, true, null, full)).toEqual({
      kind: "line_full",
      active: 2,
      maxStations: 2,
    });
    // A line of one that another station works: full at 1 of 1 (stage 2a's «занята»).
    expect(cardAction(active(), DEVICE, true, null, figures([working(OTHER)], 1))).toEqual({
      kind: "line_full",
      active: 1,
      maxStations: 1,
    });
    // A closed or paused participant holds no slot.
    expect(
      cardAction(
        active(),
        DEVICE,
        true,
        null,
        figures([working(OTHER, "closed"), working(OTHER, "left")]),
      ),
    ).toEqual({ kind: "join", enabled: true });
  });

  it("continues this station's own part, and a paused one while a slot is free", () => {
    const mine = figures([working(DEVICE), working(OTHER)], 2, "active");
    expect(cardAction(active(), DEVICE, false, null, mine)).toEqual({
      kind: "continue",
      enabled: false,
    });
    expect(cardAction(active({ entered: true }), DEVICE, false, null, mine)).toEqual({
      kind: "continue",
      enabled: true,
    });
    const paused = figures([working(DEVICE, "left"), working(OTHER)], 2, "left");
    expect(cardAction(active({ entered: true }), DEVICE, true, null, paused)).toEqual({
      kind: "continue",
      enabled: true,
    });
    const pausedFull = figures(
      [
        working(DEVICE, "left"),
        working(OTHER),
        { row: participant(HANDHELD, "ТСД 1", "active"), accepted: 1 },
      ],
      2,
      "left",
    );
    expect(cardAction(active({ entered: true }), DEVICE, true, null, pausedFull)).toEqual({
      kind: "line_full",
      active: 2,
      maxStations: 2,
    });
  });

  it("offers nothing on a part the host says is closed, and finishes a shift the office closed", () => {
    const closed = figures([working(DEVICE, "closed"), working(OTHER)], 2, "closed");
    expect(cardAction(active(), DEVICE, true, null, closed)).toEqual({ kind: "part_closed" });
    expect(
      cardAction(active({ status: "closed", entered: true }), DEVICE, true, null, closed),
    ).toEqual({ kind: "finish" });
  });

  it("keeps stage 2a's answer without figures: another station's shift is busy", () => {
    expect(cardAction(active(), DEVICE, true, null, null)).toEqual({ kind: "busy" });
  });
});
