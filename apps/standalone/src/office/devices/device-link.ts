import type { DeviceRecord } from "../../host/protocol.js";

/** How long after the host last heard a device it still counts as «на связи». */
export const LINK_FRESH_MS = 5 * 60 * 1000;

export type DeviceLink = "online" | "stale" | "none";

/**
 * The «Связь» of a device row. `lastSeenAt` is the time the host last heard the device (written at
 * most once a minute, and by a stream only when it opens), so this is «heard recently», not a live
 * socket: a device heard within five minutes is «на связи», one heard before that «давно не было»,
 * one never heard or revoked «нет связи». A time ahead of this PC's clock (the host's clock runs a
 * little fast) counts as fresh.
 */
export function deviceLink(
  device: Pick<DeviceRecord, "lastSeenAt" | "revokedAt">,
  nowMs: number,
): DeviceLink {
  if (device.revokedAt !== null || device.lastSeenAt === null) return "none";
  const heard = Date.parse(device.lastSeenAt);
  if (Number.isNaN(heard)) return "stale";
  return nowMs - heard <= LINK_FRESH_MS ? "online" : "stale";
}
