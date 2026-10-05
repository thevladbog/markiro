import {
  usTraceRequestScopeV1Schema,
  type UsTraceRequestScopeV1,
} from "@markiro/platform-contracts";
import { BadRequestException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { escapeLikePattern } from "../master-data/us-master-data-support";

const all = (conditions: SQL[]) =>
  conditions.length ? sql.join(conditions, sql` AND `) : sql`true`;
export function parseRequestScope(scope: UsTraceRequestScopeV1): UsTraceRequestScopeV1 {
  const parsed = usTraceRequestScopeV1Schema.safeParse(scope);
  if (!parsed.success) throw new BadRequestException({ code: "invalid_us_request_scope" });
  const result = parsed.data;
  if (result.tlcs) result.tlcs.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (result.locationIds) result.locationIds.sort();
  return result;
}

/** Authoritative lines, including noncurrent revisions and saved drafts. */
export function requestRelations(tenantId: string) {
  return sql`WITH relations AS (
    SELECT event_id,lot_id,line_no,'receiving' AS role,'receiving' AS type FROM receiving_event_items WHERE tenant_id=${tenantId}
    UNION ALL SELECT event_id,lot_id,line_no,'input','transformation' FROM transformation_event_inputs WHERE tenant_id=${tenantId}
    UNION ALL SELECT event_id,lot_id,line_no,'output','transformation' FROM transformation_event_outputs WHERE tenant_id=${tenantId}
    UNION ALL SELECT event_id,lot_id,line_no,'shipping','shipping' FROM shipping_event_items WHERE tenant_id=${tenantId}
  )`;
}

function lotConditions(scope: UsTraceRequestScopeV1) {
  const conditions: SQL[] = [];
  if (scope.productId) conditions.push(sql`l.product_id=${scope.productId}::uuid`);
  if (scope.productText)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM products p WHERE p.tenant_id=l.tenant_id AND p.id=l.product_id AND p.name ILIKE ${`%${escapeLikePattern(scope.productText)}%`})`,
    );
  if (scope.lotId) conditions.push(sql`l.id=${scope.lotId}::uuid`);
  if (scope.tlc) conditions.push(sql`l.tlc COLLATE "C"=${scope.tlc} COLLATE "C"`);
  if (scope.tlcs) conditions.push(sql`l.tlc COLLATE "C"=ANY(${sql.param(scope.tlcs)}::text[])`);
  if (scope.tlcFrom) conditions.push(sql`l.tlc COLLATE "C">=${scope.tlcFrom} COLLATE "C"`);
  if (scope.tlcTo) conditions.push(sql`l.tlc COLLATE "C"<=${scope.tlcTo} COLLATE "C"`);
  if (scope.sourceReferenceValue)
    conditions.push(sql`l.source_reference_value=${scope.sourceReferenceValue}`);
  return conditions;
}

function arrayAt(key: "items" | "inputs" | "outputs" | "documents") {
  return sql`CASE WHEN jsonb_typeof(e.finalization_snapshot->${key})='array' THEN e.finalization_snapshot->${key} ELSE '[]'::jsonb END`;
}

/** Integrity discovery only: a deleted/misdirected child must not hide a frozen event. */
export function frozenRequestLines() {
  return sql`SELECT value,'receiving' AS role FROM jsonb_array_elements(${arrayAt("items")}) WHERE e.type='receiving'
    UNION ALL SELECT value,'shipping' FROM jsonb_array_elements(${arrayAt("items")}) WHERE e.type='shipping'
    UNION ALL SELECT value,'input' FROM jsonb_array_elements(${arrayAt("inputs")}) WHERE e.type='transformation'
    UNION ALL SELECT value,'output' FROM jsonb_array_elements(${arrayAt("outputs")}) WHERE e.type='transformation'`;
}

function touchesLot() {
  return sql`(EXISTS (SELECT 1 FROM relations r WHERE r.event_id=e.id AND r.type=e.type AND r.lot_id=l.id)
    OR EXISTS (SELECT 1 FROM (${frozenRequestLines()}) frozen WHERE frozen.value->>'lotId'=l.id::text))`;
}

function locationCondition(ids: readonly string[], tenantId: string) {
  const values = sql`${sql.param([...ids])}::text[]`;
  // Frozen records never fall back to today's master data. Drafts use only saved references.
  return sql`CASE WHEN e.finalization_snapshot IS NOT NULL THEN (
    e.finalization_snapshot->>'locationId'=ANY(${values}) OR e.finalization_snapshot->>'previousSourceLocationId'=ANY(${values})
    OR e.finalization_snapshot->'processor'->>'id'=ANY(${values}) OR e.finalization_snapshot->'shipFrom'->>'locationId'=ANY(${values})
    OR e.finalization_snapshot->'recipient'->>'locationId'=ANY(${values})
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(${arrayAt("items")} || ${arrayAt("inputs")} || ${arrayAt("outputs")}) line(value)
      WHERE line.value->'source'->>'locationId'=ANY(${values}) OR line.value->'source'->>'resolvedLocationId'=ANY(${values}) OR line.value->'source'->>'id'=ANY(${values})
        OR line.value->'source'->'location'->>'locationId'=ANY(${values}) OR line.value->'source'->'resolvedLocation'->>'locationId'=ANY(${values}))
  ) ELSE (
    e.location_id::text=ANY(${values}) OR e.previous_source_location_id::text=ANY(${values})
    OR EXISTS (SELECT 1 FROM receiving_event_items i WHERE i.tenant_id=${tenantId} AND i.event_id=e.id AND (i.source_location_id::text=ANY(${values}) OR i.source_reference_location_id::text=ANY(${values})))
    OR EXISTS (SELECT 1 FROM transformation_event_inputs i WHERE i.tenant_id=${tenantId} AND i.event_id=e.id AND i.source_location_id::text=ANY(${values}))
    OR EXISTS (SELECT 1 FROM shipping_event_details d WHERE d.tenant_id=${tenantId} AND d.event_id=e.id AND d.recipient_location_id::text=ANY(${values}))
  ) END`;
}

function eventConditions(scope: UsTraceRequestScopeV1, tenantId: string) {
  const conditions: SQL[] = [];
  if (scope.eventDateFrom) conditions.push(sql`e.event_date>=${scope.eventDateFrom}::date`);
  if (scope.eventDateTo) conditions.push(sql`e.event_date<=${scope.eventDateTo}::date`);
  if (scope.locationIds) conditions.push(locationCondition(scope.locationIds, tenantId));
  if (scope.documentNumber)
    conditions.push(sql`CASE WHEN e.finalization_snapshot IS NOT NULL THEN
    EXISTS (SELECT 1 FROM jsonb_array_elements(${arrayAt("documents")}) d(value)
      WHERE (CASE WHEN e.type='receiving' THEN d.value->'document'->>'number' ELSE d.value->>'number' END)=${scope.documentNumber})
    ELSE EXISTS (SELECT 1 FROM (
      SELECT document_id FROM receiving_event_documents WHERE tenant_id=${tenantId} AND event_id=e.id
      UNION ALL SELECT document_id FROM transformation_event_documents WHERE tenant_id=${tenantId} AND event_id=e.id
      UNION ALL SELECT document_id FROM shipping_event_documents WHERE tenant_id=${tenantId} AND event_id=e.id
    ) linked JOIN reference_documents d ON d.tenant_id=${tenantId} AND d.id=linked.document_id WHERE d.number=${scope.documentNumber}) END`);
  return conditions;
}

export function requestSeedQueries(tenantId: string, input: UsTraceRequestScopeV1) {
  const scope = parseRequestScope(input);
  const identity = lotConditions(scope),
    event = eventConditions(scope, tenantId);
  return {
    scope,
    hasLotSelectors: identity.length > 0,
    lots: (after?: string) => sql`${requestRelations(tenantId)} SELECT l.id FROM traceability_lots l
      WHERE l.tenant_id=${tenantId} AND (${all(identity)})
      ${
        event.length
          ? sql`AND EXISTS (SELECT 1 FROM traceability_events e
        WHERE e.tenant_id=${tenantId} AND ${touchesLot()} AND (${all(event)}))`
          : sql``
      }
      ${after ? sql`AND l.id>${after}::uuid` : sql``} ORDER BY l.id LIMIT 501`,
    events: sql`${requestRelations(tenantId)} SELECT e.id FROM traceability_events e WHERE e.tenant_id=${tenantId}
      AND e.type IN ('receiving','transformation','shipping') AND (${all(event)})
      ${
        identity.length
          ? sql`AND EXISTS (SELECT 1 FROM traceability_lots l
        WHERE l.tenant_id=${tenantId} AND ${touchesLot()} AND (${all(identity)}))`
          : sql``
      }
      ORDER BY e.id LIMIT 501`,
  };
}
