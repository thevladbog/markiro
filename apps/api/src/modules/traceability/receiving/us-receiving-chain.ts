import { sql, type SQL } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "./us-receiving-persistence";

/** Complete root validation in SQL, independent of pagination. Scope uses the local r alias.
 * No row locks: all reads must share the caller's repeatable-read snapshot.
 * This checks persisted Receiving integrity, not future downstream dependency acceptance.
 */
export async function assertReceivingRootsReadable(
  tx: UsMasterDataTransaction,
  tenantId: string,
  scope: SQL,
) {
  const result = await tx.execute<{ invalid: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM receiving_event_roots r
      LEFT JOIN traceability_events original ON original.tenant_id=r.tenant_id
        AND original.root_event_id=r.id AND original.id=r.id AND original.revision=1
      CROSS JOIN LATERAL (
        SELECT count(*) AS allocated,max(revision) AS last_revision,
          count(*)+count(*) FILTER (WHERE status<>'draft')+
          count(*) FILTER (WHERE status='void' AND finalization_snapshot IS NOT NULL) AS expected_version
        FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id
      ) totals
      WHERE r.tenant_id=${tenantId} AND (${scope}) AND (
        original.id IS NULL OR r.next_revision::bigint<>totals.last_revision::bigint+1
        OR totals.allocated<>totals.last_revision OR r.lifecycle_version<>totals.expected_version
        OR EXISTS (
          SELECT 1 FROM traceability_events e
          LEFT JOIN traceability_events p ON p.tenant_id=e.tenant_id AND p.root_event_id=e.root_event_id AND p.id=e.previous_revision_id
          LEFT JOIN traceability_events s ON s.tenant_id=e.tenant_id AND s.root_event_id=e.root_event_id AND s.id=e.superseded_by_event_id
          WHERE e.tenant_id=r.tenant_id AND e.root_event_id=r.id AND (
            e.type<>'receiving' OR e.status NOT IN ('draft','finalized','amended','void')
            OR e.event_number IS DISTINCT FROM r.event_number OR e.time_zone IS DISTINCT FROM original.time_zone
            OR (e.status='finalized' AND (r.current_event_id IS DISTINCT FROM e.id OR e.superseded_by_event_id IS NOT NULL))
            OR (e.status='draft' AND r.pending_draft_id IS DISTINCT FROM e.id)
            OR EXISTS (SELECT 1 FROM receiving_event_items i WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id
              AND i.previous_line_no IS NOT NULL AND NOT receiving_retained_line_matches(i))
            OR (e.status IN ('finalized','amended') AND e.finalization_snapshot IS NULL)
            OR (e.revision=1 AND e.previous_revision_id IS NOT NULL)
            OR (e.revision>1 AND (p.id IS NULL OR p.revision>=e.revision OR p.finalization_snapshot IS NULL
              OR (e.status='draft' AND (p.status<>'finalized' OR r.current_event_id IS DISTINCT FROM p.id))
              OR (e.finalization_snapshot IS NOT NULL AND (p.status<>'amended' OR p.superseded_by_event_id IS DISTINCT FROM e.id))))
            OR (e.status='amended' AND (s.id IS NULL OR s.revision<=e.revision OR s.previous_revision_id IS DISTINCT FROM e.id
              OR s.finalization_snapshot IS NULL OR e.superseded_by IS DISTINCT FROM s.finalized_by OR e.superseded_at IS DISTINCT FROM s.finalized_at))
            OR (e.finalization_snapshot IS NOT NULL AND (CASE e.finalization_snapshot->'snapshotVersion'
              WHEN '1'::jsonb THEN receiving_snapshot_v1_shape_valid(e.finalization_snapshot)
              WHEN '2'::jsonb THEN receiving_snapshot_v2_shape_valid(e.finalization_snapshot)
              WHEN '3'::jsonb THEN receiving_snapshot_v3_shape_valid(e.finalization_snapshot)
              ELSE false END) IS NOT TRUE)
          )
        )
        OR (r.current_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM traceability_events WHERE tenant_id=r.tenant_id
          AND root_event_id=r.id AND id=r.current_event_id AND status='finalized' AND superseded_by_event_id IS NULL))
        OR (r.pending_draft_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM traceability_events WHERE tenant_id=r.tenant_id
          AND root_event_id=r.id AND id=r.pending_draft_id AND status='draft'))
      )
    ) AS invalid
  `);
  if (result.rows[0]?.invalid !== false) throw unavailable();
}
