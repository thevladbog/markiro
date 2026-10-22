import {
  deviceShiftSchema,
  deviceShiftsSchema,
  enteredShiftSchema,
  type DeviceShift,
  type EnteredShift,
  type ShiftParticipant,
} from "../../src/host/protocol.js";
import { fixture } from "./proto-fixture.js";

/** Another station of the line, a third one, and the handheld of the host's fixture. */
export const OTHER_STATION = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
export const THIRD_STATION = "1f3c2e4d-5a6b-4c7d-8e9f-a0b1c2d3e4f5";
export const HANDHELD = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the fixture has no ${what}`);
  return value;
}

/**
 * The host's shared shift (`device-shifts-participants.json`): this station (`DEVICE_ID`) active
 * with 427 accepted, the handheld closed with 120, two to the line, 547 in all at 09:41:07Z.
 * Same id, number and product as `device-shift-entered.json`.
 */
export const SHARED: DeviceShift = must(
  deviceShiftsSchema.parse(fixture("device-shifts-participants.json")).shifts[0],
  "shared shift",
);
const ENTERED = enteredShiftSchema.parse(fixture("device-shift-entered.json"));

/** `shift` as the answer of an entry: the same fields and `device-shift-entered.json`'s snapshot. */
export function enteredOf(shift: DeviceShift): EnteredShift {
  return enteredShiftSchema.parse({ ...shift, snapshot: ENTERED.snapshot });
}

/** The shared shift entered by this station. */
export const SHARED_ENTERED: EnteredShift = enteredOf(SHARED);

/** This station's row of the fixture: the model of every participant row below. */
export const STATION_ROW: ShiftParticipant = must(SHARED.participants?.[0], "station row");

/** A participant row of `deviceId` in `state`. */
export function participant(
  deviceId: string,
  deviceName: string,
  state: ShiftParticipant["state"],
  deviceKind: ShiftParticipant["deviceKind"] = "station",
): ShiftParticipant {
  return {
    ...STATION_ROW,
    deviceId,
    deviceName,
    deviceKind,
    state,
    leftAt: state === "left" ? "2026-10-08T08:00:00Z" : null,
    closedAt: state === "closed" ? "2026-10-08T09:00:00Z" : null,
    closedBy: state === "closed" ? "device" : null,
  };
}

/**
 * The shared shift with `participants` and their accepted units (the totals add them up, at
 * `asOf`), `maxStations` to the line (2 by default) and this station's `myState` (left out when
 * `null` or absent: it never entered).
 */
export function sharedShift(input: {
  participants: readonly { row: ShiftParticipant; accepted: number }[];
  maxStations?: number;
  myState?: ShiftParticipant["state"] | null;
  asOf?: string;
  ownerDeviceId?: string;
  plannedQty?: number | null;
}): DeviceShift {
  const accepted = input.participants.reduce((sum, part) => sum + part.accepted, 0);
  const shift = deviceShiftSchema.parse({
    ...SHARED,
    ownerDeviceId: input.ownerDeviceId ?? SHARED.ownerDeviceId,
    plannedQty: input.plannedQty === undefined ? SHARED.plannedQty : input.plannedQty,
    maxStations: input.maxStations ?? 2,
    participants: input.participants.map((part) => part.row),
    totals: {
      accepted,
      boxesClosed: 0,
      pallets: 0,
      asOf: input.asOf ?? "2026-10-08T09:41:07Z",
    },
    byDevice: input.participants.map((part) => ({
      deviceId: part.row.deviceId,
      accepted: part.accepted,
      boxesClosed: 0,
      pallets: 0,
    })),
  });
  if (input.myState === undefined || input.myState === null) delete shift.myState;
  else shift.myState = input.myState;
  return shift;
}
