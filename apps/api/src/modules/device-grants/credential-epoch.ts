import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { GrantOwner } from "@markiro/domain";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

/** Construct only at authenticated native boundary; never parse from a request body. */
export type GrantCredentialIdentity =
  | { tenantId: string; deviceId: string; kind: "station" | "handheld"; apiKeyId: string }
  | { tenantId: string; deviceId: string; kind: "kiosk"; tokenHash: string };

/**
 * Caller holds required quota/timeline locks. Device before credential, before task.
 * The DB epoch trigger owns all mutations, including direct enroll and re-pair.
 * A revoked key can disappear before the durable device transaction commits: recheck
 * the live key here, under SHARE, rather than relying on epoch/revokedAt alone.
 */
export async function lockCurrentGrantOwner(
  tx: SubscriptionTransaction,
  identity: GrantCredentialIdentity,
  now: number,
): Promise<GrantOwner | null> {
  if (!Number.isSafeInteger(now) || now < 0) return null;
  if (identity.kind === "kiosk") {
    const [device] = await tx
      .select()
      .from(schema.kiosks)
      .where(
        and(eq(schema.kiosks.tenantId, identity.tenantId), eq(schema.kiosks.id, identity.deviceId)),
      )
      .for("update");
    if (
      !device ||
      device.status !== "active" ||
      !device.deviceTokenHash ||
      device.deviceTokenHash !== identity.tokenHash
    )
      return null;
    return {
      tenantId: device.tenantId,
      deviceId: device.id,
      kind: "kiosk",
      credentialEpoch: device.credentialEpoch,
    };
  }
  const [device] = await tx
    .select()
    .from(schema.stationDevices)
    .where(
      and(
        eq(schema.stationDevices.tenantId, identity.tenantId),
        eq(schema.stationDevices.id, identity.deviceId),
      ),
    )
    .for("update");
  if (
    !device ||
    device.revokedAt ||
    device.kind !== identity.kind ||
    device.apiKeyId !== identity.apiKeyId
  )
    return null;
  const [key] = await tx
    .select()
    .from(schema.apikey)
    .where(
      and(
        eq(schema.apikey.id, identity.apiKeyId),
        eq(schema.apikey.configId, "station"),
        eq(schema.apikey.referenceId, identity.tenantId),
      ),
    )
    .for("share");
  if (!key || key.enabled === false || (key.expiresAt !== null && key.expiresAt.getTime() <= now))
    return null;
  return {
    tenantId: device.tenantId,
    deviceId: device.id,
    kind: identity.kind,
    credentialEpoch: device.credentialEpoch,
  };
}
