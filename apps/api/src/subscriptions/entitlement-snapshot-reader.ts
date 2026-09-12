import { createHash } from "node:crypto";
import { schema } from "@markiro/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  entitlementSourceSchema,
  platformEntitlementSourceSchema,
  entitlementEffectSchema,
  ENTITLEMENT_REGISTRY_VERSION,
  ENTITLEMENT_OPERATIONS,
  type EntitlementSource,
  type PlatformEntitlementSource,
} from "@markiro/platform-contracts";
import type { EffectiveEntitlements, EntitlementsExecutor } from "./entitlements.types";
import { SubscriptionEntitlementsInvalidException } from "./subscription-errors";

export function entitlementDigest(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item !== null && typeof item === "object")
      return `{${Object.entries(item)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
        .join(",")}}`;
    const result = JSON.stringify(item);
    if (result === undefined) throw new SubscriptionEntitlementsInvalidException();
    return result;
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export const entitlementRegistryFingerprint = () =>
  `${ENTITLEMENT_REGISTRY_VERSION}:${entitlementDigest(ENTITLEMENT_OPERATIONS)}`;
export function platformSource(
  row: typeof schema.entitlementSources.$inferSelect,
): PlatformEntitlementSource {
  return platformEntitlementSourceSchema.parse({
    id: row.id,
    versionId: row.versionId,
    version: row.version,
    tenantId: row.tenantId,
    subscriptionId: row.subscriptionId,
    kind: row.kind,
    prepared: row.prepared,
    effects: row.effects,
    operationIds: row.operationIds,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    reason: row.reason,
    decisionReference: row.decisionReference,
    requestId: row.requestId,
    createdByPlatformUserId: row.createdByPlatformUserId,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByPlatformUserId: row.revokedByPlatformUserId,
  });
}
export function safeSource(row: PlatformEntitlementSource): EntitlementSource {
  return entitlementSourceSchema.parse({
    id: row.id,
    versionId: row.versionId,
    kind: row.kind,
    prepared: true,
    effects: row.effects,
    operationIds: row.operationIds,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  });
}
/** Coherent transaction inputs shared by every date in a temporal projection. */
export async function loadEntitlementTimeline(tx: EntitlementsExecutor, tenantId: string) {
  const subscriptions = await tx
    .select()
    .from(schema.tenantSubscriptions)
    .where(eq(schema.tenantSubscriptions.tenantId, tenantId))
    .orderBy(asc(schema.tenantSubscriptions.createdAt), asc(schema.tenantSubscriptions.id));
  const additions = await tx
    .select()
    .from(schema.subscriptionAddons)
    .where(eq(schema.subscriptionAddons.tenantId, tenantId))
    .orderBy(asc(schema.subscriptionAddons.id));
  const rows = await tx
    .select()
    .from(schema.entitlementSources)
    .where(eq(schema.entitlementSources.tenantId, tenantId))
    .orderBy(asc(schema.entitlementSources.id));
  const ids = [
    ...new Set([
      ...subscriptions.map((row) => row.planVersionId),
      ...additions.map((row) => row.addonVersionId),
    ]),
  ];
  const versions = ids.length
    ? await tx
        .select()
        .from(schema.catalogItemVersions)
        .where(inArray(schema.catalogItemVersions.id, ids))
        .orderBy(asc(schema.catalogItemVersions.id))
    : [];
  const plans = ids.length
    ? await tx
        .select()
        .from(schema.planEntitlements)
        .where(inArray(schema.planEntitlements.catalogVersionId, ids))
        .orderBy(asc(schema.planEntitlements.catalogVersionId))
    : [];
  const effects = ids.length
    ? await tx
        .select()
        .from(schema.addonEntitlements)
        .where(inArray(schema.addonEntitlements.catalogVersionId, ids))
        .orderBy(
          asc(schema.addonEntitlements.catalogVersionId),
          asc(schema.addonEntitlements.entitlementKey),
        )
    : [];
  const policyIds = versions.flatMap((row) =>
    row.lifecyclePolicyId ? [row.lifecyclePolicyId] : [],
  );
  const policies = policyIds.length
    ? await tx
        .select()
        .from(schema.entitlementLifecyclePolicies)
        .where(inArray(schema.entitlementLifecyclePolicies.id, policyIds))
        .orderBy(asc(schema.entitlementLifecyclePolicies.id))
    : [];
  const invitations = await tx
    .select({ expiresAt: schema.invitation.expiresAt })
    .from(schema.invitation)
    .where(
      and(eq(schema.invitation.organizationId, tenantId), eq(schema.invitation.status, "pending")),
    );
  const [revision] = await tx
    .select()
    .from(schema.entitlementRevisions)
    .where(eq(schema.entitlementRevisions.tenantId, tenantId));
  return {
    subscriptions,
    additions,
    rows,
    versions,
    plans,
    effects,
    policies,
    invitations,
    revision,
  };
}
export type EntitlementTimeline = Awaited<ReturnType<typeof loadEntitlementTimeline>>;
/** Reads only on the caller's transaction; no independent query/transaction escapes. */
export async function readEntitlementFacts(
  tx: EntitlementsExecutor,
  current: EffectiveEntitlements,
  loaded?: EntitlementTimeline,
) {
  const tenantId = current.tenantId;
  const timeline = loaded ?? (await loadEntitlementTimeline(tx, tenantId));
  const { subscriptions, rows, invitations, revision } = timeline;
  const additions = timeline.additions.filter((row) =>
    ["active", "scheduled"].includes(row.status),
  );
  const sourceDetails = rows.map(platformSource);
  const sources: EntitlementSource[] = [];
  const versionIds = new Set<string>();
  if (current.subscription) versionIds.add(current.subscription.planVersionId);
  if (current.access === "managed" && current.subscription) {
    const plan = timeline.plans.find(
      (row) => row.catalogVersionId === current.subscription?.planVersionId,
    );
    if (!plan) throw new SubscriptionEntitlementsInvalidException();
    sources.push(
      entitlementSourceSchema.parse({
        id: current.subscription.id,
        versionId: current.subscription.planVersionId,
        kind: "plan",
        prepared: false,
        effects: [],
        operationIds: [],
        startsAt: current.subscription.startsAt?.toISOString() ?? null,
        endsAt: current.subscription.endsAt?.toISOString() ?? null,
        plan: {
          quotas: {
            lines: plan.maxLines,
            stations: plan.maxStations,
            kiosks: plan.maxKiosks,
            cabinetUsers: plan.maxCabinetUsers,
          },
          features: {
            labelEditor: plan.labelEditorEnabled,
            publicApi: plan.publicApiEnabled,
            pallets: plan.palletsEnabled,
            chzIntegration: plan.chzIntegrationEnabled,
            inventory: plan.inventoryEnabled,
            commerceMl: plan.commerceMlEnabled,
            handheld: plan.handheldEnabled,
          },
        },
      }),
    );
    for (const addon of additions.filter(
      (row) => row.subscriptionId === current.subscription?.id,
    )) {
      versionIds.add(addon.addonVersionId);
      const version = timeline.versions.find(
        (row) =>
          row.id === addon.addonVersionId &&
          row.kind === "addon" &&
          ["published", "retired"].includes(row.status),
      );
      if (!version || (addon.status === "scheduled" && !addon.startsAt))
        throw new SubscriptionEntitlementsInvalidException();
      const effects = timeline.effects.filter(
        (row) => row.catalogVersionId === addon.addonVersionId,
      );
      if (!effects.length) throw new SubscriptionEntitlementsInvalidException();
      sources.push(
        entitlementSourceSchema.parse({
          id: addon.id,
          versionId: addon.addonVersionId,
          kind: "addon",
          prepared: false,
          startsAt: addon.startsAt?.toISOString() ?? null,
          endsAt: addon.endsAt?.toISOString() ?? null,
          operationIds: [],
          effects: effects.map((effect) => {
            const parsed = entitlementEffectSchema.parse(
              effect.quotaIncrement === null
                ? { key: effect.entitlementKey, featureEnabled: effect.featureEnabled }
                : { key: effect.entitlementKey, quotaIncrement: effect.quotaIncrement },
            );
            return "quotaIncrement" in parsed
              ? { ...parsed, quotaIncrement: parsed.quotaIncrement * addon.quantity }
              : parsed;
          }),
        }),
      );
    }
  }
  sources.push(
    ...sourceDetails
      .filter((row) => row.subscriptionId === current.subscription?.id && row.revokedAt === null)
      .map(safeSource),
  );
  const versions = timeline.versions
    .filter((row) => versionIds.has(row.id))
    .map((row) => ({ id: row.id, policyId: row.lifecyclePolicyId }));
  const policyIds = versions.flatMap((version) => (version.policyId ? [version.policyId] : []));
  const policies = timeline.policies.filter((row) => policyIds.includes(row.id));
  const policyFacts = policies.map((policy) => ({
    id: policy.id,
    version: policy.version,
    status: policy.status,
    payloadHash: policy.payloadHash,
    payloadDigest: entitlementDigest(policy.payload),
    approvedAt: policy.approvedAt?.toISOString() ?? null,
    decisionReference: policy.decisionReference,
  }));
  return {
    sources,
    sourceDetails,
    revision: revision?.revision.toString() ?? "0",
    usageRevision: revision?.usageRevision.toString() ?? "0",
    boundaries: [
      ...subscriptions
        .filter((row) => !["cancelled", "superseded"].includes(row.status))
        .flatMap((row) => [row.startsAt, row.endsAt]),
      ...additions.flatMap((row) => [row.startsAt, row.endsAt]),
      ...invitations.map((row) => row.expiresAt),
    ],
    readinessReasons:
      !versions.length ||
      versions.some(
        (version) =>
          !version.policyId ||
          !policies.some(
            (policy) => policy.id === version.policyId && policy.status === "approved",
          ),
      )
        ? ["lifecycle_policy_required"]
        : [],
    policyFingerprint: entitlementDigest({ versions, policies: policyFacts }),
    versionIds: versions.map((version) => version.id),
    policyIds,
  };
}
