import { sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { assertReceivingRootsReadable } from "../receiving/us-receiving-chain";
import { unavailable } from "../receiving/us-receiving-persistence";

export type TraceDirection = "backward" | "forward" | "both";

/** Start at children, including excluded revisions: a broken parent must fail closed. */
export function traceRelations(tenantId: string, lotIds: readonly string[]) {
  const ids = sql`${sql.param([...new Set(lotIds)])}::uuid[]`;
  return sql`WITH children AS (
    SELECT event_id,lot_id,'receiving' AS type,'backward' AS direction FROM receiving_event_items
      WHERE tenant_id=${tenantId} AND lot_id=ANY(${ids})
    UNION ALL SELECT event_id,lot_id,'transformation','forward' FROM transformation_event_inputs
      WHERE tenant_id=${tenantId} AND lot_id=ANY(${ids})
    UNION ALL SELECT event_id,lot_id,'transformation','backward' FROM transformation_event_outputs
      WHERE tenant_id=${tenantId} AND lot_id=ANY(${ids})
    UNION ALL SELECT event_id,lot_id,'shipping','forward' FROM shipping_event_items
      WHERE tenant_id=${tenantId} AND lot_id=ANY(${ids})
  ), roots AS (
    SELECT id,current_event_id,pending_draft_id,event_number,next_revision,'receiving' AS type
      FROM receiving_event_roots WHERE tenant_id=${tenantId}
    UNION ALL SELECT id,current_event_id,pending_draft_id,event_number,next_revision,'transformation'
      FROM transformation_event_roots WHERE tenant_id=${tenantId}
    UNION ALL SELECT id,current_event_id,pending_draft_id,event_number,next_revision,'shipping'
      FROM shipping_event_roots WHERE tenant_id=${tenantId}
  )`;
}

export async function assertTraceRelations(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: readonly string[],
) {
  if (!lotIds.length) return;
  const result = await tx.execute<{ invalid: boolean }>(sql`${traceRelations(tenantId, lotIds)}
    SELECT EXISTS (
      SELECT 1 FROM children child
      LEFT JOIN traceability_events e ON e.tenant_id=${tenantId} AND e.id=child.event_id
      LEFT JOIN roots r ON r.id=e.root_event_id AND r.type=child.type
      WHERE e.id IS NULL OR e.type<>child.type OR r.id IS NULL
    ) OR EXISTS (
      SELECT 1 FROM traceability_events e
      JOIN roots r ON r.id=e.root_event_id AND r.type=e.type
      WHERE e.tenant_id=${tenantId} AND r.id IN (
        SELECT root_event_id FROM traceability_events touched WHERE touched.tenant_id=${tenantId}
          AND touched.id IN (SELECT event_id FROM children)
      ) AND (
        e.event_number<>r.event_number OR e.revision>=r.next_revision
        OR (e.revision=1 AND (e.id<>r.id OR e.previous_revision_id IS NOT NULL))
        OR (e.revision>1 AND NOT EXISTS (SELECT 1 FROM traceability_events p
          WHERE p.tenant_id=${tenantId} AND p.id=e.previous_revision_id AND p.root_event_id=r.id
            AND p.type=e.type AND p.revision<e.revision AND p.finalization_snapshot IS NOT NULL))
        OR (e.status='finalized' AND (r.current_event_id IS DISTINCT FROM e.id OR e.superseded_by_event_id IS NOT NULL))
        OR (e.status='draft' AND r.pending_draft_id IS DISTINCT FROM e.id)
        OR (r.current_event_id=e.id AND (e.status<>'finalized' OR e.superseded_by_event_id IS NOT NULL))
        OR (r.pending_draft_id=e.id AND e.status<>'draft')
        OR (r.current_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM traceability_events c
          WHERE c.tenant_id=${tenantId} AND c.root_event_id=r.id AND c.id=r.current_event_id
            AND c.type=r.type AND c.status='finalized' AND c.superseded_by_event_id IS NULL))
        OR (e.status='amended' AND NOT EXISTS (SELECT 1 FROM traceability_events s
          WHERE s.tenant_id=${tenantId} AND s.root_event_id=r.id AND s.id=e.superseded_by_event_id
            AND s.previous_revision_id=e.id AND s.revision>e.revision AND s.type=r.type AND s.finalization_snapshot IS NOT NULL))
      )
    ) AS invalid`);
  if (result.rows[0]?.invalid !== false) throw unavailable();
  await assertReceivingRootsReadable(
    tx,
    tenantId,
    sql`r.id IN (
    SELECT e.root_event_id FROM receiving_event_items i
    JOIN traceability_events e ON e.tenant_id=i.tenant_id AND e.id=i.event_id
    WHERE i.tenant_id=${tenantId} AND i.lot_id=ANY(${sql.param([...lotIds])}::uuid[]))`,
  );
}

export function traceCandidateQuery(
  tenantId: string,
  lotIds: readonly string[],
  direction: TraceDirection,
  limit: number,
) {
  return sql`${traceRelations(tenantId, lotIds)}
    SELECT e.id FROM traceability_events e
    JOIN roots r ON r.id=e.root_event_id AND r.type=e.type AND r.current_event_id=e.id
    WHERE e.tenant_id=${tenantId} AND e.status='finalized' AND e.superseded_by_event_id IS NULL
      AND EXISTS (SELECT 1 FROM children c WHERE c.event_id=e.id
        ${direction === "both" ? sql`` : sql`AND c.direction=${direction}`})
    ORDER BY e.event_date,e.id LIMIT ${limit + 1}`;
}
