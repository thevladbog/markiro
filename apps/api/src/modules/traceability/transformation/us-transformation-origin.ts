import { schema } from "@markiro/db";
import { NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "./us-transformation-persistence";

/** Internal tenant-scoped origin projection; callers own authorization and transaction scope. */
export async function readCurrentTransformationOrigin(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
): Promise<{ lotId: string; currentOrigin: boolean; eventId: string | null }> {
  const [lot] = await tx
    .select({ id: schema.traceabilityLots.id })
    .from(schema.traceabilityLots)
    .where(
      and(eq(schema.traceabilityLots.tenantId, tenantId), eq(schema.traceabilityLots.id, lotId)),
    );
  if (!lot) throw new NotFoundException({ code: "transformation_reference_not_found" });
  const result = await tx.execute<{
    event_id: string;
    status: string;
    superseded_by_event_id: string | null;
    current_event_id: string | null;
  }>(sql`
    SELECT e.id AS event_id,e.status,e.superseded_by_event_id,r.current_event_id
    FROM transformation_event_outputs o
    JOIN traceability_events e ON e.tenant_id=o.tenant_id AND e.id=o.event_id AND e.type='transformation'
    LEFT JOIN transformation_event_roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id
    WHERE o.tenant_id=${tenantId} AND o.lot_id=${lotId}
      AND (e.status='finalized' OR r.current_event_id=e.id)
    ORDER BY e.id
  `);
  if (
    result.rows.length > 1 ||
    result.rows.some(
      (row) =>
        row.status !== "finalized" ||
        row.superseded_by_event_id !== null ||
        row.current_event_id !== row.event_id,
    )
  )
    throw unavailable();
  const eventId = result.rows[0]?.event_id ?? null;
  return { lotId, currentOrigin: eventId !== null, eventId };
}
