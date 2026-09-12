import { schema } from "@markiro/db";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

/** Caller already owns all quota locks, timeline and stable device rows. The
 * read-committed writer must finish these locks BEFORE capturing complete facts.
 * Revision is last; no no-op updates or artificial entitlement revision bumps. */
export async function lockDeviceLicensingFacts(tx: SubscriptionTransaction, tenantId: string) {
  const devices = await tx
    .select({ apiKeyId: schema.stationDevices.apiKeyId })
    .from(schema.stationDevices)
    .where(eq(schema.stationDevices.tenantId, tenantId));
  const credentialIds = devices.flatMap((row) => (row.apiKeyId ? [row.apiKeyId] : []));
  if (credentialIds.length)
    await tx
      .select({ id: schema.apikey.id })
      .from(schema.apikey)
      .where(inArray(schema.apikey.id, credentialIds))
      .orderBy(asc(schema.apikey.id))
      .for("share");
  const subscriptions = await tx
    .select({ versionId: schema.tenantSubscriptions.planVersionId })
    .from(schema.tenantSubscriptions)
    .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
  const addons = await tx
    .select({ versionId: schema.subscriptionAddons.addonVersionId })
    .from(schema.subscriptionAddons)
    .where(eq(schema.subscriptionAddons.tenantId, tenantId));
  const versionIds = [...new Set([...subscriptions, ...addons].map((row) => row.versionId))].sort();
  const versions = versionIds.length
    ? await tx
        .select({
          id: schema.catalogItemVersions.id,
          policyId: schema.catalogItemVersions.lifecyclePolicyId,
        })
        .from(schema.catalogItemVersions)
        .where(inArray(schema.catalogItemVersions.id, versionIds))
        .orderBy(asc(schema.catalogItemVersions.id))
        .for("share")
    : [];
  const policyIds = [
    ...new Set(versions.flatMap((row) => (row.policyId ? [row.policyId] : []))),
  ].sort();
  if (policyIds.length)
    await tx
      .select({ id: schema.entitlementLifecyclePolicies.id })
      .from(schema.entitlementLifecyclePolicies)
      .where(inArray(schema.entitlementLifecyclePolicies.id, policyIds))
      .orderBy(asc(schema.entitlementLifecyclePolicies.id))
      .for("share");
  await tx.execute(
    sql`select tenant_id from entitlement_revisions where tenant_id=${tenantId} for update`,
  );
}
