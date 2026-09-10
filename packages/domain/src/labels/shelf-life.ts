const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Plain calendar-day addition on a `YYYY-MM-DD` string — no timezone is
 * involved at any point.
 *
 * The arithmetic runs in UTC deliberately: UTC has no DST, so "+184 days"
 * is always exactly 184 midnights and a daylight-saving transition inside
 * the window can never shift the printed day by one. Doing the same with
 * local-time `Date` math would.
 *
 * Returns "" for a malformed or non-existent date (e.g. `2025-02-30`).
 */
export function addCalendarDays(isoDate: string, days: number): string {
  const parts = ISO_DATE.exec(isoDate);
  if (!parts) return "";
  const [, year, month, day] = parts;
  const yearNumber = Number(year);
  if (yearNumber < 1 || yearNumber > 9999) return "";
  const base = new Date(0);
  base.setUTCFullYear(yearNumber, Number(month) - 1, Number(day));
  if (Number.isNaN(base.getTime())) return "";
  // Reject dates that do not exist and silently rolled over (2025-02-30).
  if (base.getUTCMonth() !== Number(month) - 1 || base.getUTCDate() !== Number(day)) return "";
  base.setUTCDate(base.getUTCDate() + days);
  if (Number.isNaN(base.getTime())) return "";
  if (base.getUTCFullYear() < 1 || base.getUTCFullYear() > 9999) return "";
  return `${pad(base.getUTCFullYear(), 4)}-${pad(base.getUTCMonth() + 1, 2)}-${pad(base.getUTCDate(), 2)}`;
}

/**
 * Last usable calendar day, inclusive: production day is day one.
 * For example, 2026-09-10 with 365 days expires on 2027-09-09.
 * Missing/invalid shelf life or production dates produce an empty label field.
 */
export function shelfLifeExpiryDate(productionDate: string, shelfLifeDays: number | null): string {
  if (shelfLifeDays === null || !Number.isInteger(shelfLifeDays) || shelfLifeDays <= 0) return "";
  return addCalendarDays(productionDate, shelfLifeDays - 1);
}
