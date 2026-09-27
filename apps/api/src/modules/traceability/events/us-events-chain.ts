import { sql, type SQL } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "../receiving/us-receiving-persistence";

/** Complete typed chain validation; scope uses r, never status or page predicates. */
export async function assertTransformationRootsReadable(
  tx: UsMasterDataTransaction,
  tenantId: string,
  scope: SQL,
) {
  const result = await tx.execute<{ invalid: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM transformation_event_roots r
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
          CROSS JOIN LATERAL (SELECT
            CASE WHEN jsonb_typeof(e.finalization_snapshot->'inputs')='array' THEN e.finalization_snapshot->'inputs' ELSE '[]'::jsonb END AS inputs,
            CASE WHEN jsonb_typeof(e.finalization_snapshot->'outputs')='array' THEN e.finalization_snapshot->'outputs' ELSE '[]'::jsonb END AS outputs,
            CASE WHEN jsonb_typeof(e.finalization_snapshot->'documents')='array' THEN e.finalization_snapshot->'documents' ELSE '[]'::jsonb END AS documents
          ) frozen
          WHERE e.tenant_id=r.tenant_id AND e.root_event_id=r.id AND (
            e.type<>'transformation' OR e.status NOT IN ('draft','finalized','amended','void')
            OR e.event_number IS DISTINCT FROM r.event_number OR e.time_zone IS DISTINCT FROM original.time_zone
            OR (e.status='finalized') IS DISTINCT FROM (r.current_event_id IS NOT DISTINCT FROM e.id)
            OR (e.status='draft') IS DISTINCT FROM (r.pending_draft_id IS NOT DISTINCT FROM e.id)
            OR (e.status='finalized' AND e.superseded_by_event_id IS NOT NULL)
            OR (e.status IN ('finalized','amended') AND e.finalization_snapshot IS NULL)
            OR (e.revision=1 AND (e.previous_revision_id IS NOT NULL OR e.amendment_reason IS NOT NULL))
            OR (e.revision>1 AND (p.id IS NULL OR p.revision>=e.revision OR e.amendment_reason IS NULL
              OR (p.status NOT IN ('finalized','amended') AND NOT (e.status='void' AND e.finalized_at IS NULL AND p.status='void'))
              OR (e.status='draft' AND r.current_event_id IS DISTINCT FROM p.id)
              OR (e.finalization_snapshot IS NOT NULL AND (p.status<>'amended' OR p.superseded_by_event_id IS DISTINCT FROM e.id))))
            OR (e.status='draft' AND e.revision=1 AND r.current_event_id IS NOT NULL)
            OR (e.status='amended' AND (s.id IS NULL OR s.revision<=e.revision OR s.previous_revision_id IS DISTINCT FROM e.id
              OR s.finalization_snapshot IS NULL OR e.superseded_by IS DISTINCT FROM s.finalized_by OR e.superseded_at IS DISTINCT FROM s.finalized_at))
            OR (e.status='void' AND e.void_reason IS NULL)
            OR (e.finalization_snapshot IS NOT NULL AND (
              e.finalization_snapshot->'snapshotVersion' IS DISTINCT FROM '1'::jsonb
              OR e.finalization_snapshot->>'eventId' IS DISTINCT FROM e.id::text
              OR e.finalization_snapshot->>'eventNumber' IS DISTINCT FROM e.event_number
              OR e.finalization_snapshot->'revision' IS DISTINCT FROM to_jsonb(e.revision)
              OR e.finalization_snapshot->>'previousRevisionId' IS DISTINCT FROM e.previous_revision_id::text
              OR e.finalization_snapshot->>'eventDate' IS DISTINCT FROM e.event_date::text
              OR e.finalization_snapshot->>'timeZone' IS DISTINCT FROM e.time_zone
              OR e.finalized_by IS NULL OR e.finalized_at IS NULL
              OR e.finalization_snapshot->'finalizedBy' IS DISTINCT FROM to_jsonb(e.finalized_by)
              -- Server snapshots use the same millisecond UTC projection as the header.
              -- Compare text instead of casting corrupt JSON into a timestamp.
              OR e.finalization_snapshot->'finalizedAt' IS DISTINCT FROM
                to_jsonb(to_char(e.finalized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
              OR e.finalization_snapshot#>>'{processor,id}' IS DISTINCT FROM e.location_id::text
              OR jsonb_typeof(e.finalization_snapshot#>'{processor,description}') IS DISTINCT FROM 'string'
              OR coalesce(length(btrim(e.finalization_snapshot#>>'{processor,description}')),0) NOT BETWEEN 1 AND 2000
              OR jsonb_typeof(e.finalization_snapshot->'inputs') IS DISTINCT FROM 'array'
              OR jsonb_typeof(e.finalization_snapshot->'outputs') IS DISTINCT FROM 'array'
              OR jsonb_typeof(e.finalization_snapshot->'documents') IS DISTINCT FROM 'array'
              OR jsonb_array_length(frozen.inputs) NOT BETWEEN 1 AND 100
              OR jsonb_array_length(frozen.outputs) NOT BETWEEN 1 AND 100
              OR jsonb_array_length(frozen.documents) NOT BETWEEN 1 AND 100
              OR NOT EXISTS (SELECT 1 FROM transformation_event_details d
                WHERE d.tenant_id=e.tenant_id AND d.event_id=e.id AND d.reason IS NOT NULL
                  AND e.finalization_snapshot->'reason' IS NOT DISTINCT FROM to_jsonb(d.reason)
                  AND e.finalization_snapshot->'reasonNote' IS NOT DISTINCT FROM coalesce(to_jsonb(d.reason_note),'null'::jsonb)
                  AND e.finalization_snapshot->'notes' IS NOT DISTINCT FROM coalesce(to_jsonb(e.notes),'null'::jsonb))
              -- Compare retained line facts and source identity, never mutable master labels/coverage.
              OR (SELECT jsonb_agg(jsonb_build_object(
                    'lineNo',j->'lineNo','kind',j->'kind','lotId',j->'lotId',
                    'productId',j#>'{product,id}','source',
                      (CASE WHEN jsonb_typeof(j->'source')='object' THEN j->'source' ELSE '{}'::jsonb END)-'description',
                    'tlc',j->'tlc','reference',j->'reference','quantity',j->'quantity','unitOfMeasure',j->'unitOfMeasure') ORDER BY n)
                  FROM jsonb_array_elements(frozen.inputs) WITH ORDINALITY a(j,n))
                IS DISTINCT FROM
                  (SELECT jsonb_agg(jsonb_build_object(
                    'lineNo',i.line_no,'kind',i.kind,'lotId',i.lot_id,
                    'productId',CASE WHEN i.kind='ftl_lot' THEN l.product_id ELSE i.product_id END,
                    'source',CASE WHEN i.kind='ftl_lot' AND l.source_location_id IS NULL THEN
                      jsonb_build_object('kind','reference','id',l.source_reference_location_id,
                        'referenceKind',l.source_reference_kind,'referenceValue',l.source_reference_value)
                      ELSE jsonb_build_object('kind','location','id',CASE WHEN i.kind='ftl_lot' THEN l.source_location_id ELSE i.source_location_id END) END,
                    'tlc',CASE WHEN i.kind='ftl_lot' THEN l.tlc END,'reference',i.reference,
                    'quantity',i.quantity,'unitOfMeasure',i.unit_of_measure) ORDER BY i.line_no)
                  FROM transformation_event_inputs i LEFT JOIN traceability_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
                  WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id)
              OR (SELECT jsonb_agg(jsonb_build_object(
                    'lineNo',j->'lineNo','lotId',j->'lotId','productId',j#>'{product,id}',
                    'source',j->'source','tlc',j->'tlc','quantity',j->'quantity','unitOfMeasure',j->'unitOfMeasure') ORDER BY n)
                  FROM jsonb_array_elements(frozen.outputs) WITH ORDINALITY a(j,n))
                IS DISTINCT FROM
                  (SELECT jsonb_agg(jsonb_build_object(
                    'lineNo',o.line_no,'lotId',o.lot_id,'productId',o.product_id,
                    'source',(e.finalization_snapshot->'processor')||'{"kind":"location"}'::jsonb,
                    'tlc',o.tlc,'quantity',o.quantity,'unitOfMeasure',o.unit_of_measure) ORDER BY o.line_no)
                  FROM transformation_event_outputs o WHERE o.tenant_id=e.tenant_id AND o.event_id=e.id)
              OR frozen.documents IS DISTINCT FROM
                  (SELECT jsonb_agg(jsonb_build_object('id',d.id,
                    'type',CASE WHEN d.type='other' THEN d.type_other_label ELSE d.type::text END,'number',d.number) ORDER BY link.position)
                  FROM transformation_event_documents link
                  LEFT JOIN reference_documents d ON d.tenant_id=link.tenant_id AND d.id=link.document_id
                  WHERE link.tenant_id=e.tenant_id AND link.event_id=e.id)
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(frozen.inputs||frozen.outputs) j
                WHERE jsonb_typeof(j#>'{product,description}') IS DISTINCT FROM 'string'
                  OR coalesce(length(btrim(j#>>'{product,description}')),0) NOT BETWEEN 1 AND 2000
                  OR jsonb_typeof(j#>'{source,description}') IS DISTINCT FROM 'string'
                  OR coalesce(length(btrim(j#>>'{source,description}')),0) NOT BETWEEN 1 AND 2000)
            ))
          )
        )
        OR (r.current_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM traceability_events WHERE tenant_id=r.tenant_id
          AND root_event_id=r.id AND id=r.current_event_id AND type='transformation' AND status='finalized'))
        OR (r.pending_draft_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM traceability_events WHERE tenant_id=r.tenant_id
          AND root_event_id=r.id AND id=r.pending_draft_id AND type='transformation' AND status='draft'))
      )
    ) AS invalid
  `);
  if (result.rows[0]?.invalid !== false) throw unavailable();
}
