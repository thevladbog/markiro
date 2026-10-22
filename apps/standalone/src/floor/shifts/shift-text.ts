/** A civil date `YYYY-MM-DD` as the floor shows it: `ДД.ММ.ГГГГ`, never through a clock. */
export function formatCivilDate(date: string): string {
  const [year, month, day] = date.split("-");
  return year === undefined || month === undefined || day === undefined
    ? date
    : `${day}.${month}.${year}`;
}

const QUANTITY = new Intl.NumberFormat("ru-RU");

/** A count of units as the floor shows it, with the Russian thousands separator. */
export function formatQuantity(quantity: number): string {
  return QUANTITY.format(quantity);
}

/**
 * The civil date `days` after `date` (before it, for a negative count), by
 * the calendar alone, never by a clock or a zone. `Date.UTC` would read the
 * years 0–99 as 1900–1999; `setUTCFullYear` does not.
 */
export function addCivilDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  const moment = new Date(0);
  moment.setUTCFullYear(year, month - 1, day + days);
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1, 2)}-${pad(moment.getUTCDate(), 2)}`;
}

const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

/**
 * An instant as the floor's «ЧЧ:ММ» on this computer's clock (plan 2b: «данные от ЧЧ:ММ», the
 * host's time of a shared shift's figures); text that is no instant is said as it is.
 */
export function formatClock(instant: string): string {
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? instant : CLOCK.format(at);
}
