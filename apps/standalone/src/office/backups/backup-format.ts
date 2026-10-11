import type { TFunction } from "i18next";

import { isKnownTimeZone } from "../../lib/civil-date.js";

const NUMBER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const FORMATS = new Map<string | null, Intl.DateTimeFormat>();

function formatFor(zone: string | null): Intl.DateTimeFormat {
  const cached = FORMATS.get(zone);
  if (cached !== undefined) return cached;
  const format = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
    ...(zone === null ? {} : { timeZone: zone }),
  });
  FORMATS.set(zone, format);
  return format;
}

/**
 * An instant the host reported, in the organization's time zone: the
 * administrator reads "14:00" as the site's 14:00, whatever this PC's clock
 * says. Without a zone, or with one this PC lacks, in this PC's own zone.
 */
export function formatWhen(instant: string, zone: string | null = null): string {
  return formatFor(zone !== null && isKnownTimeZone(zone) ? zone : null).format(new Date(instant));
}

/** A file's size: kilobytes below a megabyte, megabytes with one decimal above. */
export function formatSize(bytes: number, t: TFunction): string {
  if (bytes < 1024 * 1024) {
    return t("office.backups.size.kb", { value: NUMBER.format(Math.ceil(bytes / 1024)) });
  }
  return t("office.backups.size.mb", { value: NUMBER.format(bytes / (1024 * 1024)) });
}
