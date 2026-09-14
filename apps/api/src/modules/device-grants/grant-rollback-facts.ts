import { sql } from "drizzle-orm";
import type { GrantRollbackMember } from "@markiro/platform-contracts";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { parseApprovedGrantPolicy, type ApprovedGrantPolicy } from "./grant-policy";

interface RollbackFactRow extends Record<string, unknown> {
  activationId: string;
  activationPreparationId: string;
  tenantId: string;
  tenantName: string;
  subscriptionId: string;
  ownerKind: "station" | "handheld" | "kiosk";
  stationDeviceId: string | null;
  kioskId: string | null;
  deviceName: string | null;
  deviceKind: string | null;
  deviceCredentialEpoch: number | null;
  deviceAvailable: boolean | null;
  activationCredentialEpoch: number;
  assignmentId: string | null;
  assignmentState: string | null;
  configurationId: string | null;
  basePolicyId: string;
  strictPolicyId: string;
  activatedAt: Date | string;
  revokedAt: Date | string | null;
  preparationState: string;
  preparationBasePolicyId: string;
  preparationStrictPolicyId: string | null;
  currentBasePolicyId: string;
  basePolicy: unknown;
  strictPolicy: unknown;
}

export interface GrantRollbackFact {
  member: GrantRollbackMember;
  active: boolean;
  preparationConfirmed: boolean;
  currentBasePolicyId: string;
  preparationBasePolicyId: string;
  preparationStrictPolicyId: string | null;
  deviceKindMatches: boolean;
  credentialMatches: boolean;
  assignmentMatches: boolean;
  configurationMatches: boolean;
}

export interface GrantRollbackFacts {
  rows: GrantRollbackFact[];
  basePolicy: ApprovedGrantPolicy;
  basePolicyPayload: Record<string, unknown>;
  basePolicyHash: string;
  basePolicyKey: string;
  strictPolicies: Map<string, ApprovedGrantPolicy>;
}

export async function readGrantRollbackFacts(
  tx: SubscriptionTransaction,
  activationIds: readonly string[],
): Promise<GrantRollbackFacts | null> {
  const selected = JSON.stringify(
    [...activationIds].sort().map((activationId, ordinal) => ({ activationId, ordinal })),
  );
  const result = await tx.execute<RollbackFactRow>(sql`
    with selected as (
      select * from jsonb_to_recordset(${selected}::jsonb)
        as input("activationId" uuid, ordinal integer)
    )
    select
      a.id as "activationId", a.preparation_id as "activationPreparationId",
      a.tenant_id as "tenantId", org.name as "tenantName",
      a.subscription_id as "subscriptionId", a.owner_kind as "ownerKind",
      a.station_device_id as "stationDeviceId", a.kiosk_id as "kioskId",
      coalesce(station.name, kiosk.name) as "deviceName",
      coalesce(station.kind, 'kiosk') as "deviceKind",
      coalesce(station.credential_epoch, kiosk.credential_epoch) as "deviceCredentialEpoch",
      case when a.owner_kind = 'kiosk' then kiosk.status = 'active'
           else station.revoked_at is null end as "deviceAvailable",
      a.credential_epoch as "activationCredentialEpoch",
      assignment.id as "assignmentId", assignment.state as "assignmentState",
      configuration.id as "configurationId",
      a.base_policy_id as "basePolicyId", a.rollout_policy_id as "strictPolicyId",
      a.activated_at as "activatedAt", a.revoked_at as "revokedAt",
      preparation.state as "preparationState",
      preparation.base_policy_id as "preparationBasePolicyId",
      preparation.rollout_policy_id as "preparationStrictPolicyId",
      version.lifecycle_policy_id as "currentBasePolicyId",
      jsonb_build_object(
        'id', base_policy.id, 'policyKey', base_policy.policy_key,
        'version', base_policy.version, 'status', base_policy.status,
        'payload', base_policy.payload, 'payloadHash', base_policy.payload_hash,
        'decisionReference', base_policy.decision_reference,
        'approvedAt', base_policy.approved_at,
        'approvedByPlatformUserId', base_policy.approved_by_platform_user_id,
        'createdByPlatformUserId', base_policy.created_by_platform_user_id,
        'createdAt', base_policy.created_at
      ) as "basePolicy",
      jsonb_build_object(
        'id', strict_policy.id, 'policyKey', strict_policy.policy_key,
        'version', strict_policy.version, 'status', strict_policy.status,
        'payload', strict_policy.payload, 'payloadHash', strict_policy.payload_hash,
        'decisionReference', strict_policy.decision_reference,
        'approvedAt', strict_policy.approved_at,
        'approvedByPlatformUserId', strict_policy.approved_by_platform_user_id,
        'createdByPlatformUserId', strict_policy.created_by_platform_user_id,
        'createdAt', strict_policy.created_at
      ) as "strictPolicy"
    from selected input
    join offline_grant_device_activations a on a.id = input."activationId"
    join offline_grant_activation_preparations preparation on preparation.id = a.preparation_id
    join tenant_subscriptions subscription
      on subscription.tenant_id = a.tenant_id and subscription.id = a.subscription_id
    join catalog_item_versions version on version.id = subscription.plan_version_id
    join organization org on org.id = a.tenant_id
    join entitlement_lifecycle_policies base_policy on base_policy.id = a.base_policy_id
    join entitlement_lifecycle_policies strict_policy on strict_policy.id = a.rollout_policy_id
    left join station_devices station
      on station.tenant_id = a.tenant_id and station.id = a.station_device_id
    left join kiosks kiosk on kiosk.tenant_id = a.tenant_id and kiosk.id = a.kiosk_id
    left join working_device_assignments assignment
      on assignment.tenant_id = a.tenant_id and assignment.device_id = a.station_device_id
    left join lateral (
      select configuration.id
        from device_grant_configurations configuration
       where configuration.tenant_id = a.tenant_id
         and configuration.activation_id = a.id
       order by configuration.sequence desc
       limit 1
    ) configuration on true
    order by input.ordinal
  `);
  if (result.rows.length === 0) return null;
  const first = result.rows[0]!;
  const basePolicy = parseApprovedGrantPolicy(normalizePolicy(first.basePolicy));
  if (!basePolicy) return null;
  const basePayload = policyPayload(first.basePolicy);
  const baseHash = policyHash(first.basePolicy);
  const baseKey = policyKey(first.basePolicy);
  if (!basePayload || !baseHash || !baseKey) return null;
  const strictPolicies = new Map<string, ApprovedGrantPolicy>();
  const rows: GrantRollbackFact[] = [];
  for (const row of result.rows) {
    const strict = parseApprovedGrantPolicy(normalizePolicy(row.strictPolicy));
    if (!strict) return null;
    strictPolicies.set(row.strictPolicyId, strict);
    const deviceId = row.ownerKind === "kiosk" ? row.kioskId : row.stationDeviceId;
    if (!deviceId || !row.deviceName || !row.configurationId) return null;
    rows.push({
      member: {
        activationId: row.activationId,
        activationPreparationId: row.activationPreparationId,
        tenantId: row.tenantId,
        tenantName: row.tenantName,
        subscriptionId: row.subscriptionId,
        deviceId,
        deviceKind: row.ownerKind,
        deviceName: row.deviceName,
        credentialEpoch: row.activationCredentialEpoch,
        assignmentId: row.assignmentId,
        configurationId: row.configurationId,
        basePolicyId: row.basePolicyId,
        strictPolicyId: row.strictPolicyId,
        activatedAt: new Date(row.activatedAt).toISOString(),
      },
      active: row.revokedAt === null,
      preparationConfirmed:
        row.preparationState === "confirmed" &&
        row.preparationBasePolicyId === row.basePolicyId &&
        row.preparationStrictPolicyId === row.strictPolicyId,
      currentBasePolicyId: row.currentBasePolicyId,
      preparationBasePolicyId: row.preparationBasePolicyId,
      preparationStrictPolicyId: row.preparationStrictPolicyId,
      deviceKindMatches: row.deviceKind === row.ownerKind && row.deviceAvailable === true,
      credentialMatches: row.deviceCredentialEpoch === row.activationCredentialEpoch,
      assignmentMatches:
        row.ownerKind === "kiosk" ||
        (row.assignmentId !== null && row.assignmentState === "assigned"),
      configurationMatches: true,
    });
  }
  return {
    rows,
    basePolicy,
    basePolicyPayload: basePayload,
    basePolicyHash: baseHash,
    basePolicyKey: baseKey,
    strictPolicies,
  };
}

function policyPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || !("payload" in value)) return null;
  return typeof value.payload === "object" && value.payload !== null
    ? (value.payload as Record<string, unknown>)
    : null;
}
function policyHash(value: unknown): string | null {
  return typeof value === "object" && value !== null && "payloadHash" in value
    ? String(value.payloadHash)
    : null;
}
function policyKey(value: unknown): string | null {
  return typeof value === "object" && value !== null && "policyKey" in value
    ? String(value.policyKey)
    : null;
}

function normalizePolicy(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const row = value as Record<string, unknown>;
  return {
    ...row,
    ...(typeof row.approvedAt === "string" ? { approvedAt: new Date(row.approvedAt) } : {}),
    ...(typeof row.createdAt === "string" ? { createdAt: new Date(row.createdAt) } : {}),
  };
}
