import { and, desc, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { GrantOwner } from "@markiro/domain";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { grantRolloutMode, type ApprovedGrantPolicy } from "./grant-policy";

/** Caller holds the authenticated device row lock, serializing mode transitions.
 * A missing policy never rolls back a mode already delivered to this device.
 * Only another approved policy can change it; every transition is immutable.
 */
export async function resolveGrantRollout(
  tx: SubscriptionTransaction,
  owner: GrantOwner,
  policy: ApprovedGrantPolicy | null,
  signingConfigured: boolean,
  activationId: string | null = null,
) {
  const t = schema.deviceGrantConfigurations;
  const [previous] = await tx
    .select()
    .from(t)
    .where(
      and(
        eq(t.tenantId, owner.tenantId),
        eq(t.ownerKind, owner.kind),
        owner.kind === "kiosk"
          ? eq(t.kioskId, owner.deviceId)
          : eq(t.stationDeviceId, owner.deviceId),
      ),
    )
    .orderBy(desc(t.sequence))
    .limit(1);
  const approved =
    policy && (signingConfigured || grantRolloutMode(policy, owner.deviceId) === "observe")
      ? policy
      : null;
  if (!approved && previous) return previous;
  const mode = grantRolloutMode(approved, owner.deviceId);
  const appliedActivationId = mode === "strict" ? activationId : null;
  if (
    previous &&
    previous.mode === mode &&
    previous.policyRevision === (approved?.revision ?? null) &&
    previous.activationId === appliedActivationId
  )
    return previous;
  const [record] = await tx
    .insert(t)
    .values({
      tenantId: owner.tenantId,
      ownerKind: owner.kind,
      stationDeviceId: owner.kind === "kiosk" ? null : owner.deviceId,
      kioskId: owner.kind === "kiosk" ? owner.deviceId : null,
      credentialEpoch: owner.credentialEpoch,
      mode,
      policyId: approved?.id ?? null,
      policyRevision: approved?.revision ?? null,
      decisionReference:
        approved?.rollout?.decisionReference ?? approved?.approvalReference ?? null,
      activationId: appliedActivationId,
    })
    .returning();
  if (!record) throw new Error("Grant configuration transition was not persisted");
  return record;
}
