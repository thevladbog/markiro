import { schema } from "@markiro/db";
import { NotFoundException } from "@nestjs/common";
import { and, eq, lt, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "./us-receiving-persistence";

export type ReceivingRootRow = typeof schema.receivingEventRoots.$inferSelect;

export async function createReceivingRoot(
  tx: UsMasterDataTransaction,
  { tenantId, eventId, eventNumber }: { tenantId: string; eventId: string; eventNumber: string },
): Promise<void> {
  await tx.insert(schema.receivingEventRoots).values({
    id: eventId,
    tenantId,
    eventNumber,
    pendingDraftId: eventId,
  });
}

/** Resolve immutable identity without locking the event; lock root first. */
export async function lockReceivingRoot(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
): Promise<ReceivingRootRow> {
  const events = schema.traceabilityEvents;
  const roots = schema.receivingEventRoots;
  const [event] = await tx
    .select({ rootEventId: events.rootEventId, eventNumber: events.eventNumber })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)));
  if (!event) throw new NotFoundException({ code: "receiving_draft_not_found" });
  const [root] = await tx
    .select()
    .from(roots)
    .where(and(eq(roots.tenantId, tenantId), eq(roots.id, event.rootEventId)))
    .for("update");
  if (!root || root.eventNumber !== event.eventNumber) throw unavailable();
  return root;
}

/** Caller holds the root lock and finalizes the original event in the same transaction. */
export async function finalizeOriginalReceivingRoot(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
): Promise<void> {
  const roots = schema.receivingEventRoots;
  const [updated] = await tx
    .update(roots)
    .set({ currentEventId: eventId, pendingDraftId: null, lifecycleVersion: 2 })
    .where(
      and(
        eq(roots.tenantId, tenantId),
        eq(roots.id, eventId),
        eq(roots.pendingDraftId, eventId),
        eq(roots.lifecycleVersion, 1),
      ),
    )
    .returning({ id: roots.id });
  if (!updated) throw unavailable();
}

/** Caller owns the business transaction and any pre-existing event/lot locks. */
export async function bumpReceivingBasisVersions(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: readonly string[],
): Promise<void> {
  const lots = schema.traceabilityLots;
  // An actual tuple update invalidates an older repeatable-read snapshot;
  // locking alone would not. No business field or timestamp changes here.
  for (const id of [...new Set(lotIds.map((id) => id.toLowerCase()))].sort()) {
    const [updated] = await tx
      .update(lots)
      .set({ receivingBasisVersion: sql`${lots.receivingBasisVersion} + 1` })
      .where(
        and(
          eq(lots.tenantId, tenantId),
          eq(lots.id, id),
          lt(lots.receivingBasisVersion, 2_147_483_647),
        ),
      )
      .returning({ id: lots.id });
    // Missing/cross-tenant lots and exhaustion abort all effects in the caller.
    if (!updated) throw unavailable();
  }
}
