import type { Db } from "@markiro/db";

export const QUANTITATIVE_ENTITLEMENT_KEYS = [
  "lines",
  "stations",
  "kiosks",
  "cabinetUsers",
] as const;
export type QuantitativeEntitlementKey = (typeof QUANTITATIVE_ENTITLEMENT_KEYS)[number];

export function subscriptionQuotaLockIdentity(
  tenantId: string,
  key: QuantitativeEntitlementKey,
): { namespace: string; keyOrder: number } {
  return {
    namespace: `subscription-quota:${tenantId}`,
    keyOrder: QUANTITATIVE_ENTITLEMENT_KEYS.indexOf(key) + 1,
  };
}

export const FEATURE_ENTITLEMENT_KEYS = ["labelEditor", "publicApi", "pallets"] as const;
export type FeatureEntitlementKey = (typeof FEATURE_ENTITLEMENT_KEYS)[number];

export type SubscriptionTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type EntitlementsExecutor = Db | SubscriptionTransaction;

export interface EntitlementUsage {
  lines: number;
  stations: number;
  kiosks: number;
  cabinetUsers: number;
}

export interface EntitlementContributor {
  subscriptionAddonId: string;
  catalogVersionId: string;
  quantity: number;
  quotas: Partial<Record<QuantitativeEntitlementKey, number>>;
  features: FeatureEntitlementKey[];
}

export interface EffectiveEntitlements {
  tenantId: string;
  access: "managed" | "read_only" | "unmanaged";
  subscription: {
    id: string;
    planVersionId: string;
    status: "pending_activation" | "trial" | "active" | "expired";
    startsAt: Date | null;
    endsAt: Date | null;
  } | null;
  quotas: Record<QuantitativeEntitlementKey, number | null>;
  features: Record<FeatureEntitlementKey, boolean>;
}

export interface SubscriptionAccessSnapshot {
  access: EffectiveEntitlements["access"];
  status: "unmanaged" | "pending_activation" | "trial" | "active" | "expired" | "read_only";
  startsAt: string | null;
  endsAt: string | null;
}

export type SubscriptionEnforcementMode = "managed_only" | "all";
