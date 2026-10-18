// Civil dates (`YYYY-MM-DD`) as the host reads them (`shifts::civil_date`):
// the calendar's days of the years 0001–9999, with no time and no zone. A
// production date is one, and the label never depends on a clock (stage 2a
// spec, decision 4).

const CIVIL_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** Days in `month` (1–12) of `year` in the Gregorian calendar. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The year, month and day of a civil date, or `null` for any other text. */
function parts(text: string): [year: number, month: number, day: number] | null {
  const match = CIVIL_DATE.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return [year, month, day];
}

/**
 * Whether `text` is a civil date the host takes: exactly `YYYY-MM-DD` in ASCII
 * digits, a year from 0001, a day the month has. `proto/fixtures/shift-numbers.json`
 * holds the dates the host takes and refuses, and the tests read it.
 */
export function isCivilDate(text: string): boolean {
  return parts(text) !== null;
}

/** Days since 1970-01-01 (negative before it) of a civil date `isCivilDate` accepted. */
function dayNumber(text: string): number {
  const date = parts(text);
  if (date === null) throw new RangeError(`not a civil date: ${JSON.stringify(text)}`);
  const [year, month, day] = date;
  const utc = new Date(0);
  // `Date.UTC` reads the years 0–99 as 1900–1999; `setUTCFullYear` does not.
  utc.setUTCFullYear(year, month - 1, day);
  return Math.round(utc.getTime() / 86_400_000);
}

/** How many days `to` lies after `from` (negative before it); both are civil dates. */
export function civilDaysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Whether this runtime knows `timeZone`: the host keeps any zone name that is
 * syntactically valid, and `civilToday` falls back to this PC's date for one
 * the runtime lacks, which a caller that names its day should say.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * Today's civil date in `timeZone` (the organization's IANA zone) at `now`:
 * the office plans a shift for the site's day, not for this PC's. Without a
 * zone, or with one this runtime does not know, it is this PC's own date.
 */
export function civilToday(timeZone: string | null, now: Date = new Date()): string {
  if (timeZone !== null) {
    try {
      const fields = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }).formatToParts(now);
      const field = (type: "year" | "month" | "day") =>
        Number(fields.find((part) => part.type === type)?.value);
      return `${pad(field("year"), 4)}-${pad(field("month"), 2)}-${pad(field("day"), 2)}`;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
}
