/**
 * Formats an ISO timestamp for display using the active i18next language.
 * "ru"/"en" are the only two languages the app ships (see `src/i18n/index.ts`),
 * so this maps each to its matching `Intl.DateTimeFormat` locale rather than
 * passing `i18n.language` straight through -- keeping it independent of exactly
 * how i18next's `lng` is spelled.
 *
 * Shared by the pickup orders list (`pages/pickup/index.tsx`) and the order
 * detail view (`pages/pickup/OrderDetail.tsx`), which previously each carried
 * an identical copy.
 */
export function formatCreatedAt(iso: string, language: string): string {
  const locale = language.startsWith("ru") ? "ru-RU" : "en-US";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/**
 * Same locale mapping as `formatCreatedAt`, but with second-level precision
 * (`timeStyle: "medium"` instead of `"short"`).
 *
 * Deliberately a separate function rather than widening `formatCreatedAt`,
 * which other pages (pickup list/detail) use for a different purpose and at
 * minute precision on purpose. This one exists for the conflicts cabinet
 * view's losing/winning scan-time columns (`pages/conflicts/index.tsx`):
 * a conflict is, by construction, two scans of the same code seconds apart,
 * so minute precision makes them display identically and hides the very
 * thing a manager is there to compare.
 */
export function formatScanTime(iso: string, language: string): string {
  const locale = language.startsWith("ru") ? "ru-RU" : "en-US";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(
    new Date(iso),
  );
}
