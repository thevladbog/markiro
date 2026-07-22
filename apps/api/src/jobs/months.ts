/** First instant (UTC) of the month containing `now` (defaults to the current time). */
export function currentMonthUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * First instant (UTC) of the month after `now`. Relies on `Date.UTC`'s
 * month-overflow normalization, so a December `now` rolls into January of
 * the following year without any special-casing.
 */
export function nextMonthUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
