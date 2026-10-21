const MOSCOW = "Europe/Moscow";
const MEBIBYTE = 1024 * 1024;

function intlLocale(language: string): string {
  return language.startsWith("en") ? "en-GB" : "ru-RU";
}

export function formatReleaseDateTime(instant: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocale(language), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: MOSCOW,
  }).format(new Date(instant));
}

/** Megabytes with one decimal, the unit an installer of ~60 MB is read in. */
export function formatMegabytes(bytes: number, language: string): string {
  return new Intl.NumberFormat(intlLocale(language), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(bytes / MEBIBYTE);
}

export function formatByteCount(bytes: number, language: string): string {
  return new Intl.NumberFormat(intlLocale(language)).format(bytes);
}

export function percentOf(loaded: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((loaded / total) * 100)));
}
