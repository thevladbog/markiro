import type { UseQueryResult } from "@tanstack/react-query";

import type { BackupState } from "../../host/backups.js";
import type { OfficeConflictPage } from "../../host/review.js";
import type {
  DeviceRecord,
  OfficeLicense,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  OrgProfile,
} from "../../host/protocol.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { useOfficeLink } from "../office-link.js";
import { addCivilDays } from "./overview-time.js";

/** The overview reads again this often while it is open (a visible «Обновлено» label says when). */
export const OVERVIEW_POLL_MS = 30_000;

/** One block's reading of a query: still loading, failed with nothing to show, or something to show. */
export type BlockState = "loading" | "error" | "ready";

export function blockState(...queries: readonly UseQueryResult<unknown, Error>[]): BlockState {
  if (queries.some((query) => query.isError && query.data === undefined)) return "error";
  if (queries.some((query) => query.isPending)) return "loading";
  return "ready";
}

/**
 * The host's clock, read with its copies' state (`now`) and again every `OVERVIEW_POLL_MS`: what the
 * overview and a shift's card measure a device's silence by, never this PC's own clock.
 */
export function useHostClock(): UseQueryResult<BackupState, Error> {
  return useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token), {
    refetchInterval: OVERVIEW_POLL_MS,
  });
}

/** The host's time in ms as of its last answer; `null` while it has not answered, or its last read failed. */
export function hostNowMs(clock: UseQueryResult<BackupState, Error>): number | null {
  if (!clock.isSuccess) return null;
  const ms = Date.parse(clock.data.now);
  return Number.isNaN(ms) ? null : ms;
}

export interface OverviewData {
  admin: boolean;
  org: UseQueryResult<OrgProfile, Error>;
  shifts: UseQueryResult<OfficeShift[], Error>;
  products: UseQueryResult<OfficeProduct[], Error>;
  lines: UseQueryResult<OfficeLine[], Error>;
  conflicts: UseQueryResult<OfficeConflictPage, Error>;
  devices: UseQueryResult<DeviceRecord[], Error>;
  backups: UseQueryResult<BackupState, Error>;
  license: UseQueryResult<OfficeLicense, Error>;
  /** The organization's zone, or `null` while this PC's own stands in. */
  zone: string | null;
  /** The organization's civil today, and the days the overview reads around it. */
  today: string;
  yesterday: string;
  tomorrow: string;
  /**
   * The moment the figures are as of, in ms: the host's clock when it has answered (a device's
   * age and a line's silence are measured by it), this PC's otherwise; the last answer's time
   * while the link is down, so a stale screen does not age on its own.
   */
  nowMs: number;
  /** When the shifts were last read, in ms; `0` before the first answer. */
  updatedAt: number;
  /** The link to the host is down: the shell says so, or a read failed with data on screen. */
  hostDown: boolean;
  refetchAll: () => void;
}

/** The shift dates the overview asks the host for: the last seven days and tomorrow. */
export function overviewPeriod(today: string): { plannedFrom: string; plannedTo: string } {
  return { plannedFrom: addCivilDays(today, -6), plannedTo: addCivilDays(today, 1) };
}

/**
 * Whether a shift of the host's answer is one of the overview's days: the host adds every shift
 * closed without its reason whatever its date (spec §12.9), which only «Требует внимания» reads.
 */
export function inOverviewPeriod(shift: OfficeShift, today: string): boolean {
  const { plannedFrom, plannedTo } = overviewPeriod(today);
  return shift.plannedDate >= plannedFrom && shift.plannedDate <= plannedTo;
}

/** Every read behind «Обзор», each its own query, so one failing leaves the others. */
export function useOverviewData(): OverviewData {
  const { user } = useOfficeSession();
  const admin = user.role === "admin";
  const link = useOfficeLink();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const zone = org.isSuccess && isKnownTimeZone(org.data.timeZone) ? org.data.timeZone : null;
  const today = civilToday(zone);
  const yesterday = addCivilDays(today, -1);
  const tomorrow = addCivilDays(today, 1);
  const period = overviewPeriod(today);
  const shifts = useOfficeQuery(
    officeKeys.shiftList(period),
    (api, token) => api.listShifts(token, period),
    { refetchInterval: OVERVIEW_POLL_MS, enabled: !org.isPending },
  );
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const conflicts = useOfficeQuery(
    officeKeys.conflictList({ reviewed: false }),
    (api, token) => api.listConflicts(token, { reviewed: false }),
    { refetchInterval: OVERVIEW_POLL_MS },
  );
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token), {
    refetchInterval: OVERVIEW_POLL_MS,
    enabled: admin,
  });
  const backups = useHostClock();
  const license = useOfficeQuery(officeKeys.license, (api, token) => api.getLicense(token));

  const staleRead = [shifts, conflicts, backups].some(
    (query) => query.isError && query.data !== undefined,
  );
  const hostDown = link.status?.state === "offline" || staleRead;
  const updatedAt = shifts.dataUpdatedAt;
  const hostNow = backups.isSuccess ? Date.parse(backups.data.now) : Date.now();
  const nowMs = hostDown && updatedAt > 0 ? updatedAt : hostNow;
  return {
    admin,
    org,
    shifts,
    products,
    lines,
    conflicts,
    devices,
    backups,
    license,
    zone,
    today,
    yesterday,
    tomorrow,
    nowMs,
    updatedAt,
    hostDown,
    refetchAll: () => {
      for (const query of [shifts, conflicts, backups, lines, products, license, org]) {
        void query.refetch();
      }
      if (admin) void devices.refetch();
    },
  };
}
