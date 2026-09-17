import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import type { GrantOwner } from "@markiro/domain";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

export const REPLACEMENT_CAPABILITY = "replacement-readiness-v1";
export const REPLACEMENT_CAPABILITY_TTL_MS = 5 * 60_000;
const capabilities = schema.workingDeviceReplacementCapabilities;
export function supportsReplacementReadiness(header: string | undefined) {
  return header?.split(",").some((value) => value.trim() === REPLACEMENT_CAPABILITY) ?? false;
}
/** Caller has revalidated and locked the live credential; no body-supplied identity or time. */
export async function observeReplacementCapability(
  tx: SubscriptionTransaction,
  owner: GrantOwner,
  header: string | undefined,
  now: Date,
) {
  const observed = {
    supported: supportsReplacementReadiness(header),
    observedAt: now,
    expiresAt: new Date(now.getTime() + REPLACEMENT_CAPABILITY_TTL_MS),
  };
  await tx
    .insert(capabilities)
    .values({
      tenantId: owner.tenantId,
      deviceId: owner.deviceId,
      credentialEpoch: owner.credentialEpoch,
      ...observed,
    })
    .onConflictDoUpdate({
      target: [capabilities.tenantId, capabilities.deviceId, capabilities.credentialEpoch],
      set: observed,
    });
  return observed.supported;
}
export async function replacementDrainEligibility(
  tx: SubscriptionTransaction,
  tenantId: string,
  deviceId: string,
  now = new Date(),
) {
  const [observation] = await tx
    .select({
      supported: capabilities.supported,
      observedAt: capabilities.observedAt,
      expiresAt: capabilities.expiresAt,
    })
    .from(schema.stationDevices)
    .innerJoin(
      capabilities,
      and(
        eq(capabilities.tenantId, schema.stationDevices.tenantId),
        eq(capabilities.deviceId, schema.stationDevices.id),
        eq(capabilities.credentialEpoch, schema.stationDevices.credentialEpoch),
      ),
    )
    .where(
      and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
    );
  return observation?.supported &&
    observation.observedAt <= now &&
    observation.expiresAt > now &&
    observation.expiresAt.getTime() - observation.observedAt.getTime() <=
      REPLACEMENT_CAPABILITY_TTL_MS
    ? { status: "eligible" as const, reasons: [] as [] }
    : {
        status: "blocked" as const,
        reasons: ["client_upgrade_required"] as ["client_upgrade_required"],
      };
}
