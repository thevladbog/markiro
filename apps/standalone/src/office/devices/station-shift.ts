import type { OfficeShift } from "../../host/protocol.js";

/**
 * The shift a station works on: the active one it opened (`ownerDeviceId`;
 * stage 2a puts one device on a shift). A planned shift is nobody's yet and a
 * closed one is over; `undefined` while the list is not loaded.
 */
export function stationShift(
  shifts: readonly OfficeShift[] | undefined,
  deviceId: string,
): OfficeShift | undefined {
  return shifts?.find((shift) => shift.status === "active" && shift.ownerDeviceId === deviceId);
}
