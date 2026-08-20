export function stationDisplayLocale(locale: string): "ru-RU" | "en-US" {
  return locale.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US";
}

/** Formats an API calendar date without allowing the local time zone to move the day. */
export function formatShiftPlannedDate(
  value: string | null | undefined,
  locale: string,
): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return stationDisplayLocale(locale) === "ru-RU"
    ? `${day}.${month}.${year}`
    : `${month}/${day}/${year}`;
}
