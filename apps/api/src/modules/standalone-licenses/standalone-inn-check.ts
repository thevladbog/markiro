import { normalizeInn } from "@markiro/domain";
import type {
  StandaloneIssuanceWarning,
  StandaloneLicenseRights,
  StandaloneSiteWarning,
} from "@markiro/platform-contracts";

/** Blank and absent are the same: no INN given. */
export function rawInn(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === "" ? null : value;
}

/** The 10 or 12 checksum-valid digits, or `null` (an invalid INN equals nothing, spec §4.9). */
export function normalizedInn(value: string | null | undefined): string | null {
  const raw = rawInn(value);
  return raw === null ? null : normalizeInn(raw);
}

/** Warnings shown before a site is bound (spec §6.2 step 1); the operator acknowledges each. */
export function siteRegistrationWarnings(input: {
  requestInn: string | null | undefined;
  trialInn: string | null | undefined;
  orgInn: string | null | undefined;
  billingInn: string | null | undefined;
}): StandaloneSiteWarning[] {
  const warnings = new Set<StandaloneSiteWarning>();
  const request = normalizedInn(input.requestInn);
  if (rawInn(input.requestInn) === null) warnings.add("request_inn_missing");
  else if (request === null) warnings.add("request_inn_invalid");
  const org = normalizedInn(input.orgInn);
  const billing = normalizedInn(input.billingInn);
  // A tenant without a cabinet has no organization profile; a valid billing INN stands in (plan Д3).
  if (org === null && billing === null) warnings.add("org_inn_missing");
  if (request !== null && org !== null && request !== org) warnings.add("request_inn_differs_org");
  if (request !== null && billing !== null && request !== billing)
    warnings.add("request_inn_differs_billing");
  const trial = normalizedInn(input.trialInn);
  if (rawInn(input.trialInn) !== null && (trial === null || trial !== request))
    warnings.add("trial_inn_differs");
  return [...warnings].sort();
}

/** The signed `customer.inn` (plan Д3): the organization profile, else billing; never an invalid one. */
export function resolveCustomerInn(input: {
  orgInn: string | null | undefined;
  billingInn: string | null | undefined;
  siteInn: string | null;
}): { inn: string | null; warnings: StandaloneIssuanceWarning[] } {
  const org = normalizedInn(input.orgInn);
  const billing = normalizedInn(input.billingInn);
  const inn = org ?? billing;
  if (inn === null) return { inn: null, warnings: [] };
  const warnings: StandaloneIssuanceWarning[] = [];
  if (org === null) warnings.push({ code: "customer_inn_from_billing" });
  else if (billing !== null && billing !== org)
    warnings.push({ code: "billing_inn_differs", billingInn: billing });
  if (input.siteInn !== inn) warnings.push({ code: "site_inn_differs", siteInn: input.siteInn });
  return { inn, warnings };
}

/** Quotas below what the site's last activation request reported (plan Д10). */
export function usageWarnings(
  rights: StandaloneLicenseRights,
  usage: { stations: number; cabinetUsers: number; lines: number } | null,
): StandaloneIssuanceWarning[] {
  if (usage === null) return [];
  const warnings: StandaloneIssuanceWarning[] = [];
  for (const quota of ["lines", "stations", "cabinetUsers"] as const) {
    const limit = rights.quotas[quota];
    if (limit !== null && limit < usage[quota])
      warnings.push({ code: "quota_below_usage", quota, limit, used: usage[quota] });
  }
  return warnings;
}

export function sameWarnings(
  expected: readonly StandaloneSiteWarning[],
  acknowledged: readonly StandaloneSiteWarning[],
): boolean {
  const ack = new Set(acknowledged);
  return ack.size === new Set(expected).size && expected.every((code) => ack.has(code));
}
