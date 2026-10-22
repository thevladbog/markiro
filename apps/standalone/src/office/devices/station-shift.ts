import type { OfficeShift } from "../../host/protocol.js";
import { deviceWorksShift } from "../shifts/participation.js";

/**
 * The shift a device works: the active one where it is an active participant (plan 2b: several
 * devices work one shift, and `ownerDeviceId` is only who opened it), or, for a host before
 * protocol 7 that names no participants, the active one it opened. A planned shift is nobody's
 * yet and a closed one is over; `undefined` while the list is not loaded.
 */
export function stationShift(
  shifts: readonly OfficeShift[] | undefined,
  deviceId: string,
): OfficeShift | undefined {
  return shifts?.find((shift) => deviceWorksShift(shift, deviceId));
}
