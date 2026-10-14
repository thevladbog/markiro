import { isKnownTimeZone } from "./civil-date.js";

/** The emergency extension's length (license spec §3.5): 72 hours, the only one in the code. */
export const EMERGENCY_MS = 72 * 60 * 60 * 1000;

type Shape = "day" | "dayMonth" | "time";

const OPTIONS: Record<Shape, Intl.DateTimeFormatOptions> = {
  day: { day: "2-digit", month: "2-digit", year: "numeric" },
  dayMonth: { day: "2-digit", month: "2-digit" },
  time: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
};

const FORMATS = new Map<string, Intl.DateTimeFormat>();

function formatter(shape: Shape, zone: string | null): Intl.DateTimeFormat {
  const known = zone !== null && isKnownTimeZone(zone) ? zone : null;
  const key = `${shape}:${known ?? ""}`;
  const cached = FORMATS.get(key);
  if (cached !== undefined) return cached;
  const format = new Intl.DateTimeFormat("ru-RU", {
    ...OPTIONS[shape],
    ...(known === null ? {} : { timeZone: known }),
  });
  FORMATS.set(key, format);
  return format;
}

/**
 * «31.10.2027» of an instant the host reported, in `zone` (the
 * organization's); this PC's own zone without one, or with one this PC lacks.
 */
export function licenseDay(instant: string, zone: string | null): string {
  return formatter("day", zone).format(new Date(instant));
}

/** «31.10» of an instant, as `licenseDay`. */
export function licenseDayMonth(instant: string, zone: string | null): string {
  return formatter("dayMonth", zone).format(new Date(instant));
}

/** «23.10 09:00» of an instant, as `licenseDay`. */
export function licenseMinute(instant: string, zone: string | null): string {
  const date = new Date(instant);
  return `${formatter("dayMonth", zone).format(date)} ${formatter("time", zone).format(date)}`;
}

/**
 * The last moment before an exclusive end (`validUntil`, a phase's end): its
 * day is the one a person reads as «по … включительно».
 */
export function lastMomentBefore(end: string): string {
  return new Date(Date.parse(end) - 1).toISOString();
}
