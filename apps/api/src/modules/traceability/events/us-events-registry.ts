import { usEventListSchema, type UsEventListQuery } from "@markiro/platform-contracts";
import { sql, type SQL } from "drizzle-orm";
import {
  escapeLikePattern,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { assertReceivingRootsReadable } from "../receiving/us-receiving-chain";
import { unavailable } from "../receiving/us-receiving-persistence";
import { assertTransformationRootsReadable } from "./us-events-chain";

/** Caller owns current READ authorization and a repeatable-read snapshot. */
export async function readEventsRegistry(
  tx: UsMasterDataTransaction,
  tenantId: string,
  query: UsEventListQuery,
) {
  const pattern = query.search ? `%${escapeLikePattern(query.search)}%` : undefined;
  const rootScope =
    pattern === undefined
      ? sql`true`
      : sql`r.event_number ILIKE ${pattern} OR EXISTS (
    SELECT 1 FROM traceability_events matching WHERE matching.tenant_id=r.tenant_id
      AND matching.root_event_id=r.id AND matching.event_number ILIKE ${pattern})`;
  // Inspect typed roots even when corrupt child types, statuses or offsets would hide them.
  if (query.type === "all" || query.type === "receiving")
    await assertReceivingRootsReadable(tx, tenantId, rootScope);
  if (query.type === "all" || query.type === "transformation")
    await assertTransformationRootsReadable(tx, tenantId, rootScope);
  if (query.type === "all" || query.type === "shipping")
    await assertShippingRootsReadable(tx, tenantId, rootScope);
  // The root-based checks cannot see orphan shells. Never omit these through an inner join.
  const orphan = await tx.execute<{ invalid: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM traceability_events e
      LEFT JOIN receiving_event_roots rr ON rr.tenant_id=e.tenant_id AND rr.id=e.root_event_id
      LEFT JOIN transformation_event_roots tr ON tr.tenant_id=e.tenant_id AND tr.id=e.root_event_id
      LEFT JOIN shipping_event_roots sr ON sr.tenant_id=e.tenant_id AND sr.id=e.root_event_id
      WHERE e.tenant_id=${tenantId} AND e.type IN ('receiving','transformation','shipping')
        AND (${query.type}='all' OR e.type=${query.type})
        AND (${pattern === undefined ? sql`true` : sql`e.event_number ILIKE ${pattern}`})
        AND ((e.type='receiving' AND (rr.id IS NULL OR tr.id IS NOT NULL OR sr.id IS NOT NULL))
          OR (e.type='transformation' AND (tr.id IS NULL OR rr.id IS NOT NULL OR sr.id IS NOT NULL))
          OR (e.type='shipping' AND (sr.id IS NULL OR rr.id IS NOT NULL OR tr.id IS NOT NULL)))) AS invalid
  `);
  if (orphan.rows[0]?.invalid !== false) throw unavailable();
  const rows = await tx.execute<{ summary: unknown }>(sql`
    SELECT jsonb_build_object(
      'id',e.id,'rootId',e.root_event_id,'type',e.type,'eventNumber',e.event_number,
      'revision',e.revision,'status',e.status,'eventDate',e.event_date,'timeZone',e.time_zone,
      'locationId',e.location_id,'updatedAt',to_char(e.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'lifecycleVersion',CASE e.type WHEN 'receiving' THEN rr.lifecycle_version WHEN 'transformation' THEN tr.lifecycle_version ELSE sr.lifecycle_version END,
      'currentEventId',CASE e.type WHEN 'receiving' THEN rr.current_event_id WHEN 'transformation' THEN tr.current_event_id ELSE sr.current_event_id END,
      'pendingDraftId',CASE e.type WHEN 'receiving' THEN rr.pending_draft_id WHEN 'transformation' THEN tr.pending_draft_id ELSE sr.pending_draft_id END,
      'locationDisplay',CASE WHEN e.status='draft' THEN l.business_name
        WHEN e.type='receiving' THEN e.finalization_snapshot#>>'{locationDescription,businessName}'
        WHEN e.type='transformation' THEN e.finalization_snapshot#>>'{processor,description}'
        ELSE e.finalization_snapshot#>>'{shipFrom,businessName}' END,
      'documentCount',CASE WHEN e.type='receiving' THEN
        (SELECT count(*)::int FROM receiving_event_documents d WHERE d.tenant_id=e.tenant_id AND d.event_id=e.id)
        WHEN e.type='transformation' THEN (SELECT count(*)::int FROM transformation_event_documents d WHERE d.tenant_id=e.tenant_id AND d.event_id=e.id)
        ELSE (SELECT count(*)::int FROM shipping_event_documents d WHERE d.tenant_id=e.tenant_id AND d.event_id=e.id) END
    ) || CASE WHEN e.type='receiving' THEN jsonb_build_object(
      'previousSourceLocationId',e.previous_source_location_id,
      'lineCount',(SELECT count(*)::int FROM receiving_event_items i WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id)
    ) WHEN e.type='transformation' THEN jsonb_build_object(
      'inputCount',(SELECT count(*)::int FROM transformation_event_inputs i WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id),
      'outputCount',(SELECT count(*)::int FROM transformation_event_outputs o WHERE o.tenant_id=e.tenant_id AND o.event_id=e.id)
    ) ELSE jsonb_build_object(
      'lineCount',(SELECT count(*)::int FROM shipping_event_items i WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id)
    ) END AS summary
    FROM traceability_events e
    LEFT JOIN receiving_event_roots rr ON e.type='receiving' AND rr.tenant_id=e.tenant_id AND rr.id=e.root_event_id
    LEFT JOIN transformation_event_roots tr ON e.type='transformation' AND tr.tenant_id=e.tenant_id AND tr.id=e.root_event_id
    LEFT JOIN shipping_event_roots sr ON e.type='shipping' AND sr.tenant_id=e.tenant_id AND sr.id=e.root_event_id
    LEFT JOIN traceability_locations l ON e.status='draft' AND l.tenant_id=e.tenant_id AND l.id=e.location_id
    WHERE e.tenant_id=${tenantId} AND e.type IN ('receiving','transformation','shipping')
      AND (${query.type}='all' OR e.type=${query.type})
      AND (${query.status === undefined ? sql`true` : sql`e.status=${query.status}`})
      AND (${pattern === undefined ? sql`true` : sql`e.event_number ILIKE ${pattern}`})
      AND (${query.history}='all' OR
        e.id=CASE e.type WHEN 'receiving' THEN rr.current_event_id WHEN 'transformation' THEN tr.current_event_id ELSE sr.current_event_id END OR
        e.id=CASE e.type WHEN 'receiving' THEN rr.pending_draft_id WHEN 'transformation' THEN tr.pending_draft_id ELSE sr.pending_draft_id END OR (
          CASE e.type WHEN 'receiving' THEN rr.current_event_id WHEN 'transformation' THEN tr.current_event_id ELSE sr.current_event_id END IS NULL AND
          CASE e.type WHEN 'receiving' THEN rr.pending_draft_id WHEN 'transformation' THEN tr.pending_draft_id ELSE sr.pending_draft_id END IS NULL AND e.status='void'
          AND NOT EXISTS (SELECT 1 FROM traceability_events later WHERE later.tenant_id=e.tenant_id
            AND later.root_event_id=e.root_event_id AND later.type=e.type AND later.status='void' AND later.revision>e.revision)
        ))
    ORDER BY e.created_at DESC,e.id DESC LIMIT ${query.limit} OFFSET ${query.offset}
  `);
  const parsed = usEventListSchema.safeParse({
    items: rows.rows.map((row) => row.summary),
    limit: query.limit,
    offset: query.offset,
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

/** Inspect every matching Shipping root before applying status, history or page filters. */
async function assertShippingRootsReadable(
  tx: UsMasterDataTransaction,
  tenantId: string,
  scope: SQL,
) {
  const result = await tx.execute<{ invalid: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM shipping_event_roots r
      LEFT JOIN traceability_events original ON original.tenant_id=r.tenant_id
        AND original.root_event_id=r.id AND original.id=r.id AND original.revision=1
      CROSS JOIN LATERAL (
        SELECT count(*) AS allocated,max(revision) AS last_revision,
          count(*)+count(*) FILTER (WHERE status<>'draft')+
          count(*) FILTER (WHERE status='void' AND finalization_snapshot IS NOT NULL) AS expected_version
        FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id
      ) totals
      WHERE r.tenant_id=${tenantId} AND (${scope}) AND (
        original.id IS NULL OR original.type<>'shipping'
        OR r.event_number IS DISTINCT FROM original.event_number
        OR r.next_revision::bigint<>totals.last_revision::bigint+1
        OR totals.allocated<>totals.last_revision
        OR r.lifecycle_version<>totals.expected_version
        OR EXISTS (
          SELECT 1 FROM traceability_events e
          LEFT JOIN traceability_events p ON p.tenant_id=e.tenant_id
            AND p.root_event_id=e.root_event_id AND p.id=e.previous_revision_id
          LEFT JOIN traceability_events s ON s.tenant_id=e.tenant_id
            AND s.root_event_id=e.root_event_id AND s.id=e.superseded_by_event_id
          WHERE e.tenant_id=r.tenant_id AND e.root_event_id=r.id AND (
            e.type<>'shipping' OR e.status NOT IN ('draft','finalized','amended','void')
            OR e.event_number IS DISTINCT FROM r.event_number
            OR e.time_zone IS DISTINCT FROM original.time_zone
            OR (e.status='finalized') IS DISTINCT FROM (r.current_event_id IS NOT DISTINCT FROM e.id)
            OR (e.status='draft') IS DISTINCT FROM (r.pending_draft_id IS NOT DISTINCT FROM e.id)
            OR (e.status='finalized' AND e.superseded_by_event_id IS NOT NULL)
            OR (e.status IN ('finalized','amended') AND e.finalization_snapshot IS NULL)
            OR (e.revision=1 AND (e.previous_revision_id IS NOT NULL OR e.amendment_reason IS NOT NULL))
            OR (e.revision>1 AND (p.id IS NULL OR p.revision>=e.revision OR e.amendment_reason IS NULL))
            OR (e.status='draft' AND e.revision>1 AND r.current_event_id IS DISTINCT FROM p.id)
            OR (e.status='draft' AND e.revision=1 AND r.current_event_id IS NOT NULL)
            OR (e.status='amended' AND (s.id IS NULL OR s.revision<=e.revision
              OR s.previous_revision_id IS DISTINCT FROM e.id))
            OR (e.status='void' AND e.void_reason IS NULL)
          )
        )
        OR (r.current_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM traceability_events
          WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND id=r.current_event_id
            AND type='shipping' AND status='finalized'))
        OR (r.pending_draft_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM traceability_events
          WHERE tenant_id=r.tenant_id AND root_event_id=r.id AND id=r.pending_draft_id
            AND type='shipping' AND status='draft'))
      )
    ) AS invalid
  `);
  if (result.rows[0]?.invalid !== false) throw unavailable();
}
