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
