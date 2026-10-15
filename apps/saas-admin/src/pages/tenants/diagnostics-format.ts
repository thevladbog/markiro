import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  STANDALONE_DIAGNOSTICS_ERROR_CODES,
  type StandaloneUsageMonth,
} from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";

/** A report older than this many days is marked: the page then shows old facts. */
export const STALE_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

const KNOWN_ERRORS = new Set<string>(STANDALONE_DIAGNOSTICS_ERROR_CODES);

export function diagnosticsErrorCode(error: unknown): string | null {
  return error instanceof ApiRequestError ? error.code : null;
}

/** The i18n key of a refusal; a code outside the contract reads as the generic one. */
export function diagnosticsErrorKey(error: unknown): string {
  const code = diagnosticsErrorCode(error);
  return code !== null && KNOWN_ERRORS.has(code)
    ? `tenants.detail.diagnostics.errors.${code}`
    : "tenants.detail.diagnostics.errors.generic";
}

export function useDiagnosticsDate(): (value: string) => string {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage?.startsWith("en") ? "en-GB" : "ru-RU";
  return (value) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Moscow",
    }).format(new Date(value));
}

/** Whole days between `iso` and `now` (never negative). */
export function daysAgo(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS));
}

/** The longest span (months) whose gaps are filled in; a wider one is listed as it came. */
export const MAX_FILLED_MONTHS = 60;

/**
 * Every `YYYY-MM` from the first to the last month, so a gap stays a row that says «no data».
 * The server keeps months near the report's date, but the page must not trust that: a span
 * wider than `MAX_FILLED_MONTHS` is not expanded, only the months that exist are listed.
 */
export function monthRange(months: readonly string[]): string[] {
  const sorted = [...new Set(months)].sort();
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) return [];
  const span =
    (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
    Number(last.slice(5, 7)) -
    Number(first.slice(5, 7)) +
    1;
  if (!(span <= MAX_FILLED_MONTHS)) return sorted;
  const range: string[] = [];
  let year = Number(first.slice(0, 4));
  let month = Number(first.slice(5, 7));
  for (;;) {
    const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    range.push(key);
    if (key >= last) return range;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

/** The chart's ceiling (at least 1); a loop, because spreading a long array into `Math.max` throws. */
export function barMax(series: readonly { values: readonly (number | null)[] }[]): number {
  let max = 1;
  for (const item of series)
    for (const value of item.values) if (value !== null && value > max) max = value;
  return max;
}

/** «2 из 3», «занято 4 из 3» over the limit, «0 из ∞» without a limit. */
export function quotaText(
  t: TFunction,
  quota: { limit: number | null; used: number; over: boolean },
): string {
  const prefix = "tenants.detail.diagnostics.overview";
  if (quota.limit === null) return t(`${prefix}.quotaUnlimited`, { used: quota.used });
  return t(quota.over ? `${prefix}.quotaOverOf` : `${prefix}.quotaOf`, {
    used: quota.used,
    limit: quota.limit,
  });
}

/** One row of the month table: the counters the operator reads, derived from the stored month. */
export function monthRow(stats: StandaloneUsageMonth) {
  const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);
  return {
    aggregation: stats.shifts.aggregation,
    validation: stats.shifts.validation,
    validationPrint: stats.shifts.validationPrint,
    withPallets: stats.shifts.withPallets,
    accepted: stats.scans.accepted,
    duplicates: stats.scans.duplicates,
    rejected: stats.scans.rejected,
    boxes: stats.boxes.closed,
    codesPerBox:
      stats.boxes.closed === 0
        ? null
        : Math.round((stats.boxes.codes / stats.boxes.closed) * 10) / 10,
    pallets: stats.pallets.closed,
    exceptions: sum(stats.exceptions),
    conflicts: sum(stats.conflicts),
    reprints: sum(stats.reprints),
    disaggregation: stats.disaggregationApplied,
    syncRejected: stats.syncRejected,
  };
}
