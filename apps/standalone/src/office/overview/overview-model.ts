import type { ExportSettings } from "../../host/export-files.js";
import type { DeviceKind, DeviceRecord, OfficeShift } from "../../host/protocol.js";
import { shiftUnits } from "../shifts/shift-list.js";

/** A device that reported within this long, by the host's clock, counts as on line. */
export const ONLINE_WINDOW_MS = 10 * 60 * 1000;
/** This PC's clock and the host's differ by more than this: the office warns. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** The store of kept files is this full or fuller: the office warns. */
export const STORE_WARN_RATIO = 0.8;

export interface ShiftBuckets {
  /** Shifts the stations are working now, by number. */
  active: OfficeShift[];
  /** Planned for `today` and not opened yet, by number. */
  plannedToday: OfficeShift[];
  /** Shifts of `today` already closed. */
  closedToday: number;
}

const byNumber = (a: OfficeShift, b: OfficeShift) =>
  a.number.localeCompare(b.number, "ru", { numeric: true });

/** The host's list of shifts as the overview reads it, for the civil date `today`. */
export function shiftBuckets(shifts: readonly OfficeShift[], today: string): ShiftBuckets {
  return {
    active: shifts.filter((shift) => shift.status === "active").sort(byNumber),
    plannedToday: shifts
      .filter((shift) => shift.status === "planned" && shift.plannedDate === today)
      .sort(byNumber),
    closedToday: shifts.filter((shift) => shift.status === "closed" && shift.plannedDate === today)
      .length,
  };
}

export interface ShiftProgress {
  done: number;
  /** The plan, or `null` for a shift without one. */
  planned: number | null;
  /** Whole percent of the plan done, at most 100; `null` without a plan. */
  percent: number | null;
}

/** What a shift output against its plan. */
export function shiftProgress(shift: OfficeShift): ShiftProgress {
  const done = shiftUnits(shift);
  const planned = shift.plannedQty;
  return {
    done,
    planned,
    percent: planned === null ? null : Math.min(100, Math.round((done / planned) * 100)),
  };
}

export interface DeviceKindSummary {
  online: number;
  total: number;
}

export interface DeviceSummary {
  byKind: Record<DeviceKind, DeviceKindSummary>;
  /** Devices that are not on line, the longest silent first; a device never seen comes first. */
  silent: DeviceRecord[];
}

/** Whether `device` reported within `ONLINE_WINDOW_MS` before `nowMs`. */
export function isOnline(device: DeviceRecord, nowMs: number): boolean {
  return device.lastSeenAt !== null && nowMs - Date.parse(device.lastSeenAt) <= ONLINE_WINDOW_MS;
}

/** Devices not revoked, counted by kind, with the ones that are silent. */
export function deviceSummary(devices: readonly DeviceRecord[], nowMs: number): DeviceSummary {
  const byKind: Record<DeviceKind, DeviceKindSummary> = {
    station: { online: 0, total: 0 },
    office: { online: 0, total: 0 },
    handheld: { online: 0, total: 0 },
  };
  const silent: DeviceRecord[] = [];
  for (const device of devices) {
    if (device.revokedAt !== null) continue;
    byKind[device.kind].total += 1;
    if (isOnline(device, nowMs)) byKind[device.kind].online += 1;
    else silent.push(device);
  }
  silent.sort(
    (a, b) =>
      (a.lastSeenAt === null ? -Infinity : Date.parse(a.lastSeenAt)) -
      (b.lastSeenAt === null ? -Infinity : Date.parse(b.lastSeenAt)),
  );
  return { byKind, silent };
}

/** Devices (not revoked) that run another version than the host. */
export function versionSkew(
  devices: readonly DeviceRecord[],
  hostVersion: string | null,
): DeviceRecord[] {
  if (hostVersion === null) return [];
  return devices.filter((device) => device.revokedAt === null && device.appVersion !== hostVersion);
}

/** How far this PC's clock is from the host's `hostNow`, in milliseconds (positive: this PC is ahead). */
export function clockSkewMs(hostNow: string, pcNowMs: number): number {
  return pcNowMs - Date.parse(hostNow);
}

/** Whether the store of kept files is nearly full. */
export function storeNearlyFull(settings: ExportSettings): boolean {
  return settings.storedBytes / settings.maxStoredBytes >= STORE_WARN_RATIO;
}
