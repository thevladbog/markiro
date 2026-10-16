import { useTranslation } from "react-i18next";
import type { TagPhase } from "@markiro/ui";
import type { StandaloneIssuanceWarning, StandaloneSite } from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";

export const standaloneSitesKey = (tenantId: string) =>
  ["platform", "tenants", tenantId, "standalone-sites"] as const;

/** The latest file's phase; the tone follows the phase only (tag vocabulary). */
export function licensePhase(
  site: Pick<StandaloneSite, "latestIssuance" | "renewalDue">,
  now: Date,
): TagPhase {
  if (!site.latestIssuance) return "none";
  if (Date.parse(site.latestIssuance.validUntil) <= now.getTime()) return "retired";
  return site.renewalDue ? "attention" : "active";
}

export function useStandaloneDate(): (value: string) => string {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage?.startsWith("en") ? "en-GB" : "ru-RU";
  return (value) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Moscow" }).format(
      new Date(value),
    );
}

const KNOWN_ERRORS = new Set([
  "standalone_site_warnings_unacknowledged",
  "standalone_site_host_taken",
  "standalone_site_host_registered",
  "standalone_site_host_unchanged",
  "standalone_site_request_conflict",
  "standalone_site_history_full",
  "standalone_license_preview_stale",
  "standalone_license_subscription_required",
  "standalone_license_inn_required",
  "standalone_license_signing_unavailable",
  "standalone_license_request_conflict",
  "standalone_license_grace_invalid",
  "standalone_license_assignments_required",
  "standalone_license_offline_terms_removed",
]);

export function standaloneErrorKey(error: unknown): string {
  return error instanceof ApiRequestError && error.code !== null && KNOWN_ERRORS.has(error.code)
    ? `tenants.detail.standalone.errors.${error.code}`
    : "tenants.detail.standalone.errors.generic";
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function standaloneWarningText(t: Translate, warning: StandaloneIssuanceWarning): string {
  const prefix = "tenants.detail.standalone.warnings";
  switch (warning.code) {
    case "customer_inn_from_billing":
      return t(`${prefix}.customer_inn_from_billing`);
    case "billing_inn_differs":
      return t(`${prefix}.billing_inn_differs`, { billingInn: warning.billingInn });
    case "site_inn_differs":
      return t(`${prefix}.site_inn_differs`, {
        siteInn: warning.siteInn ?? t("tenants.detail.standalone.noValue"),
      });
    case "quota_below_usage":
      return t(`${prefix}.quota_below_usage`, {
        quota: t(`entitlements.quotas.${warning.quota}`),
        limit: warning.limit,
        used: warning.used,
      });
    case "feature_unmapped":
      return t(`${prefix}.feature_unmapped`, {
        feature: t(`entitlements.features.${warning.feature}`),
      });
  }
}
