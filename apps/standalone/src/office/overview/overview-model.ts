import type { ExportSettings } from "../../host/export-files.js";
import type { DeviceKind, DeviceRecord, OfficeLine, OfficeShift } from "../../host/protocol.js";
import { lineMaxStations } from "../../host/requests.js";
import { isSilent, lastSign, participantsOf } from "../shifts/participation.js";
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

/** An active participant of a shift of a line of several devices that the host has not heard for too long. */
export interface SilentParticipant {
  deviceId: string;
  name: string;
  shiftId: string;
  shiftNumber: string;
  lineName: string;
  /** The host's last sign of it (its last hearing, else its entry), an instant. */
  since: string;
}

/**
 * The silent participants of the active shifts, the longest silent first (plan 2b, spec §7: an active
 * participant silent for more than ten minutes, `PARTICIPANT_SILENT_MS`). Only a line whose limit is above
 * one counts: on a line of one the silent station is the plain device row's, as before, so a site that
 * did not turn several devices on sees no new row. `nowMs` is the Overview's clock (the host's time of its
 * latest read), so the mark moves with the 30-second poll, not by itself. A device in `revoked` is left out.
 */
export function silentParticipants(
  shifts: readonly OfficeShift[],
  lines: readonly OfficeLine[],
  nowMs: number,
  revoked: ReadonlySet<string> = new Set(),
): SilentParticipant[] {
  const found: SilentParticipant[] = [];
  for (const shift of shifts) {
    if (shift.status !== "active") continue;
    const line = lines.find((each) => each.id === shift.lineId);
    if (line === undefined || lineMaxStations(line) <= 1) continue;
    for (const each of participantsOf(shift)) {
      // A revoked device holds no slot (the host frees it) and the plain silent-device row leaves it
      // out too: its open part is the card's «Станции» and the forced close's to show, not a standing alarm.
      if (revoked.has(each.deviceId) || !isSilent(each, nowMs)) continue;
      found.push({
        deviceId: each.deviceId,
        name: each.deviceName,
        shiftId: shift.id,
        shiftNumber: shift.number,
        lineName: line.name,
        since: lastSign(each),
      });
    }
  }
  return found.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

/** A closed shift its devices closed without the reason the plan's gap needed. */
export interface ReasonMissingShift {
  shiftId: string;
  number: string;
}

/** The shifts of the list the host marked `closeReasonMissing`, in the list's order. */
export function reasonMissingShifts(shifts: readonly OfficeShift[]): ReasonMissingShift[] {
  return shifts
    .filter((shift) => shift.status === "closed" && shift.closeReasonMissing === true)
    .map((shift) => ({ shiftId: shift.id, number: shift.number }));
}

/** How far this PC's clock is from the host's `hostNow`, in milliseconds (positive: this PC is ahead). */
export function clockSkewMs(hostNow: string, pcNowMs: number): number {
  return pcNowMs - Date.parse(hostNow);
}

/** Whether the store of kept files is nearly full. */
export function storeNearlyFull(settings: ExportSettings): boolean {
  return settings.storedBytes / settings.maxStoredBytes >= STORE_WARN_RATIO;
}
