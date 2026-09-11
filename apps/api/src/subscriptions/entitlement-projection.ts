import {
  ENTITLEMENT_FEATURE_KEYS,
  ENTITLEMENT_OPERATIONS,
  entitlementSnapshotV1Schema,
  type EntitlementSource,
  type EntitlementSnapshotV1,
  type EntitlementOperationId,
  type EntitlementCandidateFeatures,
  type EntitlementQuotas,
} from "@markiro/platform-contracts";
import type {
  EffectiveEntitlements,
  EntitlementUsage,
  SubscriptionEnforcementMode,
} from "./entitlements.types";
import { SubscriptionEntitlementsInvalidException } from "./subscription-errors";

export interface EntitlementProjectionInput {
  current: EffectiveEntitlements;
  usage: EntitlementUsage;
  sources: EntitlementSource[];
  at: Date;
  enforcementMode: SubscriptionEnforcementMode;
  revision: string;
  usageRevision: string;
  boundaries: (Date | null)[];
  readinessReasons: string[];
}
export function sourceActiveAt(source: EntitlementSource, at: Date): boolean {
  return (
    (source.startsAt === null || Date.parse(source.startsAt) <= at.getTime()) &&
    (source.endsAt === null || Date.parse(source.endsAt) > at.getTime())
  );
}
function quotas(
  limits: EffectiveEntitlements["quotas"],
  usage: EntitlementUsage,
): EntitlementQuotas {
  const quota = (key: keyof EntitlementUsage) => ({
    limit: limits[key],
    used: usage[key],
    remaining: limits[key] === null ? null : Math.max(0, limits[key] - usage[key]),
  });
  return {
    lines: quota("lines"),
    stations: quota("stations"),
    kiosks: quota("kiosks"),
    cabinetUsers: quota("cabinetUsers"),
  };
}
export function projectEntitlements(input: EntitlementProjectionInput): EntitlementSnapshotV1 {
  const { current, at, sources, usage } = input;
  const active =
    current.access === "managed" ? sources.filter((source) => sourceActiveAt(source, at)) : [];
  const plan = active.find((source) => source.kind === "plan");
  const features: EntitlementCandidateFeatures = {
    ...current.features,
    chzIntegration: current.access === "read_only" ? false : null,
    inventory: current.access === "read_only" ? false : null,
    commerceMl: current.access === "read_only" ? false : null,
    handheld: current.access === "read_only" ? false : null,
  };
  const limits = { ...current.quotas };
  if (plan?.kind === "plan") {
    Object.assign(features, plan.plan.features);
    Object.assign(limits, plan.plan.quotas);
  }
  for (const source of active) {
    if (source.kind === "plan") continue;
    for (const effect of source.effects) {
      if ("featureEnabled" in effect) features[effect.key] = true;
      else {
        const base = limits[effect.key];
        if (base === null) continue;
        const value = base + effect.quotaIncrement;
        if (!Number.isSafeInteger(value)) throw new SubscriptionEntitlementsInvalidException();
        limits[effect.key] = value;
      }
    }
  }
  const boundaries = [
    ...input.boundaries,
    ...sources.flatMap((source) =>
      [source.startsAt, source.endsAt].map((value) => (value === null ? null : new Date(value))),
    ),
  ];
  const next = boundaries
    .filter((value): value is Date => value !== null && value > at)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const reasons = new Set(input.readinessReasons);
  if (current.access === "unmanaged") reasons.add("subscription_unmanaged");
  if (current.access === "read_only") reasons.add("subscription_read_only");
  if (ENTITLEMENT_FEATURE_KEYS.some((key) => features[key] === null))
    reasons.add("mapping_required");
  return entitlementSnapshotV1Schema.parse({
    version: 1,
    tenantId: current.tenantId,
    asOf: at.toISOString(),
    countedAt: at.toISOString(),
    revision: input.revision,
    usageRevision: input.usageRevision,
    nextChangeAt: next?.toISOString() ?? null,
    current: {
      access: current.access,
      writeAllowed:
        current.access === "managed" ||
        (current.access === "unmanaged" && input.enforcementMode === "managed_only"),
      subscription: current.subscription
        ? {
            ...current.subscription,
            startsAt: current.subscription.startsAt?.toISOString() ?? null,
            endsAt: current.subscription.endsAt?.toISOString() ?? null,
          }
        : null,
      quotas: quotas(current.quotas, usage),
      features: current.features,
    },
    candidate: { quotas: quotas(limits, usage), features },
    sources,
    readiness: { mode: "shadow", reasons: [...reasons].sort() },
    historical: { available: false },
    connectivity: { observedAt: at.toISOString(), chz: "unknown", nationalCatalog: "unknown" },
  });
}
/** Module booleans explain inclusion; only this scoped evaluation answers a specific operation. */
export function evaluateEntitlementOperation(
  snapshot: EntitlementSnapshotV1,
  operationId: EntitlementOperationId,
): { outcome: "allow" | "deny" | "unknown"; reasonCodes: string[] } {
  const classification = ENTITLEMENT_OPERATIONS[operationId].class;
  // Commercial recovery only: caller still owns authorization, resource scope and fencing.
  if (classification === "continuation" || classification === "stored_read")
    return { outcome: "allow", reasonCodes: ["recovery_access_preserved"] };
  if (!snapshot.current.writeAllowed)
    return {
      outcome: "deny",
      reasonCodes: [
        snapshot.current.access === "unmanaged"
          ? "subscription_unmanaged"
          : "subscription_read_only",
      ],
    };
  if (snapshot.current.access !== "managed")
    return { outcome: "unknown", reasonCodes: ["mapping_required"] };
  const sources = snapshot.sources.filter((source) =>
    sourceActiveAt(source, new Date(snapshot.asOf)),
  );
  const values = ENTITLEMENT_OPERATIONS[operationId].features.map((feature) => {
    let unknown = false;
    for (const source of sources) {
      if (source.operationIds.length && !source.operationIds.includes(operationId)) continue;
      if (source.kind === "plan") {
        if (source.plan.features[feature] === true) return true;
        if (source.plan.features[feature] === null) unknown = true;
      } else if (
        source.effects.some((effect) => effect.key === feature && "featureEnabled" in effect)
      )
        return true;
    }
    return unknown ? null : false;
  });
  if (values.includes(false)) return { outcome: "deny", reasonCodes: ["feature_not_included"] };
  if (values.includes(null)) return { outcome: "unknown", reasonCodes: ["mapping_required"] };
  return { outcome: "allow", reasonCodes: [] };
}
