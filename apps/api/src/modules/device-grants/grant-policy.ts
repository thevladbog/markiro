import { and, desc, eq, isNull } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { GrantEventType, GrantOwner } from "@markiro/domain";
import { offlineGrantPolicySchema, type OfflineGrantPolicy } from "@markiro/platform-contracts";
import { z } from "zod";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";

export type GrantTaskBounds = Partial<
  Record<
    GrantEventType,
    { maxEvents: number; maxUnits?: number | undefined; maxContainers?: number | undefined }
  >
>;
export interface ApprovedGrantPolicy {
  id: string;
  revision: string;
  approvalReference: string;
  approvedByPlatformUserId: string;
  rollout?: NonNullable<OfflineGrantPolicy["rollout"]>;
  maxOfflineMs: number;
  maxCompletionMs: number;
  taskBounds: Partial<
    Record<"shift" | "inventoryCheck" | "inventoryRepack" | "pickup", GrantTaskBounds | undefined>
  >;
}
export function parseApprovedGrantPolicy(value: unknown): ApprovedGrantPolicy | null {
  const row = z
    .object({
      id: z.string().min(1),
      version: z.number().int().positive(),
      status: z.literal("approved"),
      payload: z.record(z.string(), z.unknown()),
      payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
      decisionReference: z.string().trim().min(1),
      approvedAt: z.date(),
      approvedByPlatformUserId: z.string().trim().min(1),
    })
    .safeParse(value);
  if (!row.success) return null;
  const policy = offlineGrantPolicySchema.safeParse(row.data.payload.offlineGrant);
  if (!policy.success || entitlementDigest(row.data.payload) !== row.data.payloadHash) return null;
  return {
    id: row.data.id,
    revision: `${row.data.id}:${row.data.version}:${row.data.payloadHash}`,
    approvalReference: row.data.decisionReference,
    approvedByPlatformUserId: row.data.approvedByPlatformUserId,
    maxOfflineMs: policy.data.maxOfflineMs,
    maxCompletionMs: policy.data.maxCompletionMs,
    taskBounds: policy.data.taskBounds,
    ...(policy.data.rollout ? { rollout: policy.data.rollout } : {}),
  };
}
/** Caller has selected the current subscription under timeline locks. No global-policy fallback. */
export async function loadApprovedGrantPolicy(
  tx: SubscriptionTransaction,
  tenantId: string,
  subscriptionId: string,
): Promise<ApprovedGrantPolicy | null> {
  const [row] = await tx
    .select({ policy: schema.entitlementLifecyclePolicies })
    .from(schema.tenantSubscriptions)
    .innerJoin(
      schema.catalogItemVersions,
      eq(schema.catalogItemVersions.id, schema.tenantSubscriptions.planVersionId),
    )
    .innerJoin(
      schema.entitlementLifecyclePolicies,
      eq(schema.entitlementLifecyclePolicies.id, schema.catalogItemVersions.lifecyclePolicyId),
    )
    .where(
      and(
        eq(schema.tenantSubscriptions.tenantId, tenantId),
        eq(schema.tenantSubscriptions.id, subscriptionId),
      ),
    )
    .for("share", { of: schema.entitlementLifecyclePolicies });
  return parseApprovedGrantPolicy(row?.policy);
}

export interface EffectiveGrantPolicy {
  policy: ApprovedGrantPolicy | null;
  activationId: string | null;
  basePolicyId: string | null;
}

export async function loadEffectiveGrantPolicy(
  tx: SubscriptionTransaction,
  owner: GrantOwner,
  subscriptionId: string,
): Promise<EffectiveGrantPolicy> {
  const base = await loadApprovedGrantPolicy(tx, owner.tenantId, subscriptionId);
  if (!base) return { policy: null, activationId: null, basePolicyId: null };
  const activation = schema.offlineGrantDeviceActivations;
  const [row] = await tx
    .select({ activation, rollout: schema.entitlementLifecyclePolicies })
    .from(activation)
    .innerJoin(
      schema.offlineGrantActivationPreparations,
      eq(schema.offlineGrantActivationPreparations.id, activation.preparationId),
    )
    .innerJoin(
      schema.entitlementLifecyclePolicies,
      eq(schema.entitlementLifecyclePolicies.id, activation.rolloutPolicyId),
    )
    .where(
      and(
        eq(activation.tenantId, owner.tenantId),
        eq(activation.subscriptionId, subscriptionId),
        eq(activation.ownerKind, owner.kind),
        eq(activation.credentialEpoch, owner.credentialEpoch),
        eq(activation.basePolicyId, base.id),
        eq(schema.offlineGrantActivationPreparations.state, "confirmed"),
        eq(schema.offlineGrantActivationPreparations.basePolicyId, activation.basePolicyId),
        eq(schema.offlineGrantActivationPreparations.rolloutPolicyId, activation.rolloutPolicyId),
        owner.kind === "kiosk"
          ? eq(activation.kioskId, owner.deviceId)
          : eq(activation.stationDeviceId, owner.deviceId),
        isNull(activation.revokedAt),
      ),
    )
    .limit(1);
  if (row) {
    const rollout = parseApprovedGrantPolicy(row.rollout);
    const effective = effectiveGrantPolicyOverlay(base, rollout, owner.deviceId);
    return {
      policy: effective,
      activationId: effective === rollout ? row.activation.id : null,
      basePolicyId: base.id,
    };
  }
  const [rolledBack] = await tx
    .select({
      activation,
      observe: schema.entitlementLifecyclePolicies,
      rollbackState: schema.offlineGrantRollbackPreparations.state,
      rollbackBasePolicyId: schema.offlineGrantRollbackPreparations.basePolicyId,
      rollbackObservePolicyId: schema.offlineGrantRollbackPreparations.observePolicyId,
    })
    .from(activation)
    .leftJoin(
      schema.offlineGrantRollbackPreparations,
      eq(schema.offlineGrantRollbackPreparations.id, activation.rollbackPreparationId),
    )
    .leftJoin(
      schema.entitlementLifecyclePolicies,
      eq(schema.entitlementLifecyclePolicies.id, activation.observePolicyId),
    )
    .where(
      and(
        eq(activation.tenantId, owner.tenantId),
        eq(activation.subscriptionId, subscriptionId),
        eq(activation.ownerKind, owner.kind),
        eq(activation.credentialEpoch, owner.credentialEpoch),
        eq(activation.basePolicyId, base.id),
        owner.kind === "kiosk"
          ? eq(activation.kioskId, owner.deviceId)
          : eq(activation.stationDeviceId, owner.deviceId),
      ),
    )
    .orderBy(desc(activation.activatedAt), desc(activation.id))
    .limit(1);
  if (
    !rolledBack ||
    rolledBack.rollbackState !== "confirmed" ||
    rolledBack.rollbackBasePolicyId !== rolledBack.activation.basePolicyId ||
    rolledBack.rollbackObservePolicyId !== rolledBack.activation.observePolicyId ||
    !rolledBack.activation.rollbackPreparationId ||
    !rolledBack.activation.observePolicyId ||
    !rolledBack.activation.rolledBackAt ||
    !rolledBack.observe
  )
    return { policy: base, activationId: null, basePolicyId: base.id };
  const observe = parseApprovedGrantPolicy(rolledBack.observe);
  return {
    policy: effectiveGrantPolicyOverlay(base, observe, owner.deviceId, "observe"),
    activationId: null,
    basePolicyId: base.id,
  };
}

export function effectiveGrantPolicyOverlay(
  base: ApprovedGrantPolicy,
  rollout: ApprovedGrantPolicy | null,
  deviceId: string,
  expectedMode: "observe" | "strict" = "strict",
): ApprovedGrantPolicy {
  if (
    !rollout ||
    rollout.rollout?.mode !== expectedMode ||
    !rollout.rollout.deviceIds.includes(deviceId) ||
    rollout.maxOfflineMs !== base.maxOfflineMs ||
    rollout.maxCompletionMs !== base.maxCompletionMs ||
    entitlementDigest(rollout.taskBounds) !== entitlementDigest(base.taskBounds)
  )
    return base;
  return rollout;
}
export function computeGrantDeadlines(input: {
  now: number;
  policy: ApprovedGrantPolicy | null;
  entitlementBoundary: number | null;
}):
  | { status: "denied"; reason: "policy_not_configured" | "facts_unknown" }
  | { status: "ready"; startNotAfter: number; completeNotAfter: number } {
  if (!input.policy) return { status: "denied", reason: "policy_not_configured" };
  const { now, policy, entitlementBoundary } = input;
  if (
    entitlementBoundary === null ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(entitlementBoundary) ||
    entitlementBoundary <= now ||
    !Number.isSafeInteger(policy.maxOfflineMs) ||
    policy.maxOfflineMs <= 0 ||
    !Number.isSafeInteger(policy.maxCompletionMs) ||
    policy.maxCompletionMs <= 0 ||
    !Number.isSafeInteger(now + policy.maxOfflineMs) ||
    !Number.isSafeInteger(now + policy.maxCompletionMs)
  )
    return { status: "denied", reason: "facts_unknown" };
  return {
    status: "ready",
    startNotAfter: Math.min(entitlementBoundary, now + policy.maxOfflineMs),
    completeNotAfter: now + policy.maxCompletionMs,
  };
}

/** Only persisted, hash-verified approved policy may select a native rollout cohort. */
export function grantRolloutMode(
  policy: ApprovedGrantPolicy | null,
  deviceId: string,
): "observe" | "strict" {
  return policy?.rollout?.deviceIds.includes(deviceId) ? policy.rollout.mode : "observe";
}
