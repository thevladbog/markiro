import { and, asc, eq, gt } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { DeviceRetentionSelection } from "@markiro/platform-contracts";
import type { EntitlementsService } from "../../subscriptions/entitlements.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { loadEntitlementTimeline } from "../../subscriptions/entitlement-snapshot-reader";

/** A saved choice authorizes membership during its uninterrupted capacity restriction.
 * Preview fingerprints include mutable work and cannot serve as ongoing authority.
 * Historical inputs below can only RETIRE a choice; current rights always come from
 * the current locked snapshot. We do not assert reconstructed historical rights.
 */
export async function retentionStillApplies(
  tx: SubscriptionTransaction,
  tenantId: string,
  selection: DeviceRetentionSelection,
  deviceId: string,
  entitlements: EntitlementsService,
  at: Date,
): Promise<boolean> {
  const boundary = new Date(selection.observation.boundary.effectiveAt);
  const limit = selection.observation.future.candidate.quotas.stations.limit;
  if (limit === null) return false;
  const timeline = await loadEntitlementTimeline(tx, tenantId);
  // Cancellation/supersession does not retain an exact authority end. Never revive
  // an old choice by pretending such a relevant period did not exist.
  const ambiguous = timeline.subscriptions.some(
    (row) =>
      ["cancelled", "superseded"].includes(row.status) &&
      (row.startsAt === null || row.startsAt <= at) &&
      (row.endsAt === null || row.endsAt > boundary),
  );
  const capacityAddons = new Set(
    timeline.effects
      .filter((row) => row.entitlementKey === "stations")
      .map((row) => row.catalogVersionId),
  );
  if (
    ambiguous ||
    timeline.additions.some(
      (row) =>
        capacityAddons.has(row.addonVersionId) &&
        ["cancelled", "superseded"].includes(row.status) &&
        (row.startsAt === null || row.startsAt <= at) &&
        (row.endsAt === null || row.endsAt > boundary),
    )
  )
    return false;
  const historical = {
    ...timeline,
    subscriptions: timeline.subscriptions.map((row) =>
      row.status === "expired" ? { ...row, status: "active" as const } : row,
    ),
    additions: timeline.additions.map((row) =>
      row.status === "expired" ? { ...row, status: "active" as const } : row,
    ),
    rows: timeline.rows
      .filter((row) => row.revokedAt === null || row.revokedAt > row.startsAt)
      .map((row) =>
        row.revokedAt === null
          ? row
          : {
              ...row,
              revokedAt: null,
              endsAt:
                row.endsAt !== null && row.endsAt < row.revokedAt ? row.endsAt : row.revokedAt,
            },
      ),
  };
  const dates = [
    ...new Set([
      boundary.getTime(),
      at.getTime(),
      ...[...historical.subscriptions, ...historical.additions, ...historical.rows]
        .flatMap((row) => [row.startsAt, row.endsAt])
        .flatMap((date) => (date && date >= boundary && date <= at ? [date.getTime()] : [])),
    ]),
  ].sort((a, b) => a - b);
  const evaluate = await entitlements.loadSnapshotTimeline(tenantId, tx, historical);
  for (const time of dates) {
    const { snapshot } = await evaluate(new Date(time));
    const candidate = snapshot.candidate.quotas.stations.limit;
    if (candidate === null || candidate > limit) return false;
  }
  // Releasing then reusing an assignment is not continuation of selected membership.
  const releases = await tx
    .select({ deviceId: schema.workingDeviceEvents.deviceId })
    .from(schema.workingDeviceEvents)
    .where(
      and(
        eq(schema.workingDeviceEvents.tenantId, tenantId),
        eq(schema.workingDeviceEvents.action, "released"),
        eq(schema.workingDeviceEvents.deviceId, deviceId),
        gt(schema.workingDeviceEvents.createdAt, new Date(selection.preparedAt)),
      ),
    )
    .orderBy(asc(schema.workingDeviceEvents.id));
  return releases.length === 0;
}
