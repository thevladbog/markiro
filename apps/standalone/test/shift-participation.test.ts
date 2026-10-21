import { describe, expect, it } from "vitest";

import {
  activeParticipants,
  closedParticipants,
  deviceWorksShift,
  isSharedShift,
  isSilent,
  LOOK_PHASE,
  notClosedParticipants,
  participantLook,
  PARTICIPANT_SILENT_MS,
  participantsOf,
  presenceOf,
} from "../src/office/shifts/participation.js";
import {
  ACTIVE,
  CLOSED,
  HANDHELD_ID,
  participant,
  PARTICIPANT_A,
  PARTICIPANT_B,
  PLANNED,
  SHARED,
  SHARED_NO_REASON,
  STATION_ID,
} from "./support/shifts.js";

const NOW = Date.parse("2026-10-08T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("the participants of a shift (plan 2b)", () => {
  it("reads a shift of a host before protocol 7 as one with no participants", () => {
    expect(participantsOf(ACTIVE)).toEqual([]);
    expect(isSharedShift(ACTIVE)).toBe(false);
    expect(isSharedShift({ participants: [PARTICIPANT_A] })).toBe(false);
    expect(isSharedShift(SHARED)).toBe(true);
  });

  it("splits participants by state", () => {
    const shift = {
      participants: [
        PARTICIPANT_A,
        participant({ deviceId: HANDHELD_ID, state: "left" }),
        participant({ deviceId: "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e", state: "closed" }),
      ],
    };
    expect(activeParticipants(shift).map((each) => each.deviceId)).toEqual([STATION_ID]);
    expect(notClosedParticipants(shift).map((each) => each.state)).toEqual(["active", "left"]);
    expect(closedParticipants(shift).map((each) => each.state)).toEqual(["closed"]);
  });
});

describe("a silent participant (the owner's ten minutes)", () => {
  it("is an active one the host has not heard for more than ten minutes", () => {
    expect(PARTICIPANT_SILENT_MS).toBe(10 * 60 * 1000);
    const heard = (lastSeenAt: string | null, state: "active" | "left" | "closed" = "active") =>
      participant({ lastSeenAt, state });
    expect(isSilent(heard(ago(10 * 60_000)), NOW)).toBe(false);
    expect(isSilent(heard(ago(10 * 60_000 + 1)), NOW)).toBe(true);
    expect(isSilent(heard(ago(60_000)), NOW)).toBe(false);
  });

  it("is never one that left or closed, and falls back to the entry when never heard", () => {
    expect(isSilent(participant({ state: "left", lastSeenAt: ago(3_600_000) }), NOW)).toBe(false);
    expect(isSilent(participant({ state: "closed", lastSeenAt: ago(3_600_000) }), NOW)).toBe(false);
    expect(isSilent(participant({ lastSeenAt: null, joinedAt: ago(60_000) }), NOW)).toBe(false);
    expect(isSilent(participant({ lastSeenAt: null, joinedAt: ago(30 * 60_000) }), NOW)).toBe(true);
  });
});

describe("how a participant looks (state by glyph and word, never by colour alone)", () => {
  it("tells work, silence, pause and the two kinds of close apart", () => {
    const fresh = ago(60_000);
    expect(participantLook(participant({ lastSeenAt: fresh }), NOW)).toBe("active");
    expect(participantLook(participant({ lastSeenAt: ago(20 * 60_000) }), NOW)).toBe("silent");
    expect(participantLook(participant({ state: "left" }), NOW)).toBe("left");
    expect(participantLook(participant({ state: "closed", closedBy: "device" }), NOW)).toBe(
      "closedDevice",
    );
    expect(participantLook(participant({ state: "closed", closedBy: "office_user" }), NOW)).toBe(
      "closedOffice",
    );
  });

  it("maps each look to a phase of the kit's vocabulary", () => {
    expect(LOOK_PHASE).toEqual({
      active: "active",
      silent: "attention",
      left: "none",
      closedDevice: "done",
      closedOffice: "done",
    });
  });
});

describe("the shift a device works (the owner is only who opened it)", () => {
  it("is, with participants, the active shift where the device is an active participant", () => {
    expect(deviceWorksShift(SHARED, HANDHELD_ID)).toBe(true);
    // The owner opened it, then left: it no longer works it.
    const ownerLeft = {
      ...SHARED,
      participants: [{ ...PARTICIPANT_A, state: "left" as const }, PARTICIPANT_B],
    };
    expect(deviceWorksShift(ownerLeft, STATION_ID)).toBe(false);
    expect(deviceWorksShift(ownerLeft, HANDHELD_ID)).toBe(true);
    expect(deviceWorksShift(SHARED, "5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e")).toBe(false);
  });

  it("is, without participants (an older host), the owner's active shift as before", () => {
    expect(deviceWorksShift(ACTIVE, STATION_ID)).toBe(true);
    expect(deviceWorksShift(ACTIVE, HANDHELD_ID)).toBe(false);
    expect(deviceWorksShift({ ...PLANNED, ownerDeviceId: STATION_ID }, STATION_ID)).toBe(false);
    expect(deviceWorksShift({ ...CLOSED, ownerDeviceId: STATION_ID }, STATION_ID)).toBe(false);
  });

  it("is never a closed shift's", () => {
    expect(deviceWorksShift(SHARED_NO_REASON, STATION_ID)).toBe(false);
  });
});

describe("a device's presence in the shifts", () => {
  it("is its state in an active shift, an active part before a paused one before a closed one", () => {
    const otherShift = {
      ...SHARED,
      id: "7e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
      number: "OCT26-006",
      participants: [{ ...PARTICIPANT_B, state: "left" as const }],
    };
    expect(presenceOf([SHARED], HANDHELD_ID)).toEqual({
      shiftId: SHARED.id,
      number: "OCT26-004",
      state: "active",
    });
    expect(presenceOf([otherShift, SHARED], HANDHELD_ID)?.state).toBe("active");
    expect(presenceOf([otherShift], HANDHELD_ID)?.state).toBe("left");
  });

  it("is none for a closed or planned shift, an unlisted device or an unread list", () => {
    expect(presenceOf([SHARED_NO_REASON, PLANNED], STATION_ID)).toBeNull();
    expect(presenceOf([SHARED], "5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e")).toBeNull();
    expect(presenceOf(undefined, STATION_ID)).toBeNull();
    // A shift of an older host names no participants, so the page claims nothing.
    expect(presenceOf([ACTIVE], STATION_ID)).toBeNull();
  });
});
