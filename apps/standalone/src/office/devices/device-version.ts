import type { TFunction } from "i18next";

import type { DeviceRecord } from "../../host/protocol.js";

/**
 * The version column of «Устройства» (plan ОБН-1): what the device reported
 * on its requests, with its protocol; or, for a device that has reported
 * nothing since it paired (an app before ОБН-1, or a host before it that
 * sends neither field), the version it named when it paired.
 */
export function deviceVersionText(device: DeviceRecord, t: TFunction): string {
  if (
    device.versionSeenAt === undefined ||
    device.versionSeenAt === null ||
    device.protocol === undefined
  ) {
    return t("office.devices.version.paired", { version: device.appVersion });
  }
  return t("office.devices.version.reported", {
    version: device.appVersion,
    protocol: device.protocol,
  });
}
