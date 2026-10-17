import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { SubscriptionTransaction } from "./entitlements.types";

/**
 * One row's status change with its event, as the status job writes it. The cabinet
 * grant uses the same function to settle a term that ended before the job ran, so
 * the job finds nothing left and the event id is the same either way.
 */
export async function transitionSubscriptionStatus(
  tx: SubscriptionTransaction,
  row: typeof schema.tenantSubscriptions.$inferSelect,
  nextStatus: "active" | "expired",
  effectiveAt: Date,
  reason: "scheduled_start_reached" | "term_ended",
): Promise<boolean> {
  const changed = await tx
    .update(schema.tenantSubscriptions)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(
      and(
        eq(schema.tenantSubscriptions.id, row.id),
        eq(schema.tenantSubscriptions.tenantId, row.tenantId),
        eq(schema.tenantSubscriptions.status, row.status),
      ),
    )
    .returning({ id: schema.tenantSubscriptions.id });
  if (changed.length !== 1) return false;
  const before = subscriptionSnapshot(row);
  const after = { ...before, status: nextStatus };
  const eventKind = nextStatus === "active" ? "plan.activated" : "plan.expired";
  await tx
    .insert(schema.subscriptionEvents)
    .values({
      id: deterministicEventId("subscription", row.id, eventKind, effectiveAt),
      tenantId: row.tenantId,
      subscriptionId: row.id,
      eventKind,
      effectiveAt,
      actorPlatformUserId: null,
      source: "subscription_status_job",
      reason,
      before,
      after,
    })
    .onConflictDoNothing({ target: schema.subscriptionEvents.id });
  return true;
}

export function deterministicEventId(
  entity: "subscription" | "addon",
  id: string,
  eventKind: string,
  effectiveAt: Date,
): string {
  const hex = createHash("sha256")
    .update(`subscription-status:${entity}:${id}:${eventKind}:${effectiveAt.toISOString()}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function subscriptionSnapshot(row: typeof schema.tenantSubscriptions.$inferSelect) {
  return {
    id: row.id,
    planVersionId: row.planVersionId,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    source: row.source,
  };
}
