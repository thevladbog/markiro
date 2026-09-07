import { NotFoundException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { receivingBasisSchema, type ReceivingBasisQuery } from "@markiro/platform-contracts";
import { and, asc, countDistinct, eq, isNull, sql } from "drizzle-orm";
import { lotResponse } from "../lots/us-lot-support";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "./us-receiving-persistence";
import { assertReceivingRootsReadable } from "./us-receiving-chain";

/** Caller supplies one authorized repeatable-read transaction for token, count and page. */
export async function readReceivingBasis(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  query: ReceivingBasisQuery,
) {
  const lots = schema.traceabilityLots,
    events = schema.traceabilityEvents,
    items = schema.receivingEventItems;
  const [lot] = await tx
    .select()
    .from(lots)
    .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lotId)));
  if (!lot) throw new NotFoundException({ code: "lot_not_found" });
  lotResponse(lot); // Corrupt business identity is unavailable, not a valid zero-support lot.
  // Receiving-only storage cannot make completeness claims about an unregistered CTE.
  // Also reject orphaned item/event/root relations rather than losing them in an inner join.
  const integrity = await tx.execute<{ invalid: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM traceability_events WHERE tenant_id=${tenantId} AND type<>'receiving')
      OR EXISTS (SELECT 1 FROM receiving_event_items i
        LEFT JOIN traceability_events e ON e.tenant_id=i.tenant_id AND e.id=i.event_id
        LEFT JOIN receiving_event_roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id
        WHERE i.tenant_id=${tenantId} AND i.lot_id=${lot.id} AND (e.id IS NULL OR r.id IS NULL)) AS invalid
  `);
  if (integrity.rows[0]?.invalid !== false) throw unavailable();
  await assertReceivingRootsReadable(
    tx,
    tenantId,
    sql`r.id IN (
    SELECT e.root_event_id FROM receiving_event_items i
    JOIN traceability_events e ON e.tenant_id=i.tenant_id AND e.id=i.event_id
    WHERE i.tenant_id=${tenantId} AND i.lot_id=${lot.id})`,
  );
  const matching = and(
    eq(items.tenantId, tenantId),
    eq(items.lotId, lot.id),
    eq(events.type, "receiving"),
    eq(events.status, "finalized"),
    isNull(events.supersededByEventId),
  );
  const relation = and(eq(events.tenantId, items.tenantId), eq(events.id, items.eventId));
  const [count] = await tx
    .select({ value: countDistinct(events.id) })
    .from(items)
    .innerJoin(events, relation)
    .where(matching);
  if (!count) throw unavailable();
  const rows = await tx
    .select({
      rootId: events.rootEventId,
      eventId: events.id,
      eventNumber: events.eventNumber,
      revision: events.revision,
      lineNos: sql<number[]>`array_agg(${items.lineNo} ORDER BY ${items.lineNo})`,
    })
    .from(items)
    .innerJoin(events, relation)
    .where(matching)
    .groupBy(events.rootEventId, events.id, events.eventNumber, events.revision)
    .orderBy(asc(events.rootEventId), asc(events.id))
    .limit(query.limit)
    .offset(query.offset);
  const parsed = receivingBasisSchema.safeParse({
    lotId: lot.id,
    basisVersion: lot.receivingBasisVersion,
    state: count.value > 0 ? "present" : "missing",
    supportCount: count.value,
    items: rows,
    ...query,
    hasMore: query.offset + rows.length < count.value,
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
