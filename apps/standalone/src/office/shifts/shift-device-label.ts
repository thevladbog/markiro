import type { TFunction } from "i18next";
import type { DeviceRecord } from "../../host/protocol.js";

/**
 * How the dialog names a device: its name, marked when revoked; the start of
 * its id when the list lacks it or was not read.
 */
export function deviceLabel(
  id: string,
  devices: readonly DeviceRecord[] | undefined,
  t: TFunction,
) {
  const device = devices?.find((each) => each.id === id);
  if (device === undefined) return t("office.shifts.totals.unknownDevice", { id: id.slice(0, 8) });
  return device.revokedAt === null
    ? device.name
    : t("office.shifts.totals.revokedDevice", { name: device.name });
}
