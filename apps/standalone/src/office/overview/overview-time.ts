import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";

// Civil days and the organization's clock for «Обзор». A shift's `plannedDate` is a civil date
// (no time, no zone), so the days of the overview are added as calendar days, never as
// multiples of 24 hours of an instant; an instant is read in the organization's zone only to
// say what time it is there.

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcMidnight(date: string): Date {
  const match = CIVIL.exec(date);
  if (match === null) throw new RangeError(`not a civil date: ${JSON.stringify(date)}`);
  const utc = new Date(0);
  utc.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return utc;
}

function civilOf(utc: Date): string {
  const year = String(utc.getUTCFullYear()).padStart(4, "0");
  const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The civil date `days` after `date` (before it when negative). */
export function addCivilDays(date: string, days: number): string {
  const utc = utcMidnight(date);
  utc.setUTCDate(utc.getUTCDate() + days);
  return civilOf(utc);
}

/** The last `count` civil days, oldest first, the last one `today`. */
export function recentCivilDays(today: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addCivilDays(today, index - (count - 1)));
}

const WEEKDAY = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("ru-RU", { day: "numeric", timeZone: "UTC" });
const HEADING = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

/** The label under a chart column: the weekday («ср») and the day of the month. */
export function civilDayLabel(date: string): { weekday: string; day: string } {
  const utc = utcMidnight(date);
  return { weekday: WEEKDAY.format(utc).replace(".", ""), day: DAY.format(utc) };
}

/** «Среда, 14 октября»: the page's date line, read from the civil date itself. */
export function civilHeading(date: string): string {
  const text = HEADING.format(utcMidnight(date));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface ZoneClock {
  /** `14:32`. */
  hm: string;
  /** `14:32:08`. */
  hms: string;
  /** `UTC+3`, `UTC+5:30`, `UTC`. */
  offset: string;
}

function offsetLabel(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "−" : "+";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return `UTC${sign}${hours}${rest === 0 ? "" : `:${String(rest).padStart(2, "0")}`}`;
}

/**
 * What time it is at `now` in `timeZone` (the organization's), with the zone's offset at that
 * instant; this PC's zone without a zone or with one this runtime does not know.
 */
export function zoneClock(now: Date, timeZone: string | null): ZoneClock {
  const zone = timeZone !== null && isKnownTimeZone(timeZone) ? timeZone : null;
  const fields = new Intl.DateTimeFormat("en-GB", {
    ...(zone === null ? {} : { timeZone: zone }),
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => Number(fields.find((part) => part.type === type)?.value ?? 0);
  const two = (n: number) => String(n).padStart(2, "0");
  const hour = value("hour") % 24;
  const wall = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    hour,
    value("minute"),
    value("second"),
  );
  const offsetMinutes = Math.round((wall - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  const hm = `${two(hour)}:${two(value("minute"))}`;
  return { hm, hms: `${hm}:${two(value("second"))}`, offset: offsetLabel(offsetMinutes) };
}

export interface DayRelation {
  /** Whether the instant falls on the organization's today, its yesterday, or another day. */
  day: "today" | "yesterday" | "other";
  hm: string;
}

/** The civil date an instant falls on in `timeZone` (this PC's zone without a known one). */
export function civilDateOf(instant: Date, timeZone: string | null): string {
  return civilToday(timeZone, instant);
}

/** Where an instant stands against the organization's `today`: «сегодня в 01:00», «вчера в 12:30». */
export function relateToToday(instant: Date, timeZone: string | null, today: string): DayRelation {
  const date = civilDateOf(instant, timeZone);
  const hm = zoneClock(instant, timeZone).hm;
  if (date === today) return { day: "today", hm };
  if (date === addCivilDays(today, -1)) return { day: "yesterday", hm };
  return { day: "other", hm };
}
