import { schema } from "@markiro/db";
import { ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";

export interface CurrentConsumer {
  lotId: string;
  eventId: string;
  rootId: string;
  revision: number;
}

/** Caller authorizes the tenant and locks all affected lots in sorted order first. */
export async function listCurrentTransformationConsumers(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: readonly string[],
): Promise<CurrentConsumer[]> {
  if (!lotIds.length) return [];
  const inputs = schema.transformationEventInputs,
    events = schema.traceabilityEvents,
    roots = schema.transformationEventRoots;
  const rows = await tx
    .select({
      lotId: inputs.lotId,
      eventId: events.id,
      rootId: roots.id,
      revision: events.revision,
    })
    .from(inputs)
    .innerJoin(events, and(eq(events.tenantId, inputs.tenantId), eq(events.id, inputs.eventId)))
    .innerJoin(
      roots,
      and(
        eq(roots.tenantId, events.tenantId),
        eq(roots.id, events.rootEventId),
        eq(roots.currentEventId, events.id),
      ),
    )
    .where(
      and(
        eq(inputs.tenantId, tenantId),
        inArray(inputs.lotId, [...new Set(lotIds)]),
        eq(inputs.kind, "ftl_lot"),
        eq(events.type, "transformation"),
        eq(events.status, "finalized"),
        isNull(events.supersededByEventId),
      ),
    )
    .orderBy(asc(inputs.lotId), asc(roots.id), asc(events.id));
  return rows.map((row) => {
    if (row.lotId === null)
      throw new ServiceUnavailableException({ code: "us_database_unavailable" });
    return { ...row, lotId: row.lotId };
  });
}

/** Actual row writes force stale repeatable-read waiters to retry with a fresh snapshot. */
export async function bumpLotDependencyVersions(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: readonly string[],
): Promise<void> {
  const lots = schema.traceabilityLots;
  for (const id of [...new Set(lotIds)].sort()) {
    const [row] = await tx
      .update(lots)
      .set({ currentDependencyVersion: sql`${lots.currentDependencyVersion} + 1` })
      .where(
        and(
          eq(lots.tenantId, tenantId),
          eq(lots.id, id),
          lt(lots.currentDependencyVersion, 2147483647),
        ),
      )
      .returning({ id: lots.id });
    if (!row) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
  }
}
