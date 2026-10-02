import { schema } from "@markiro/db";
import { isValidSscc } from "@markiro/domain";
import {
  usTraceSearchPageSchema,
  type UsTraceSearchPage,
  type UsTraceSearchQuery,
} from "@markiro/platform-contracts";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { lotResponse } from "../lots/us-lot-support";
import {
  escapeLikePattern,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { unavailable } from "../receiving/us-receiving-persistence";
import { validateCurrentTraceEvent, type TraceEventEvidence } from "./us-trace-evidence";
import { assertTraceRelations } from "./us-trace-query";

type Match = UsTraceSearchPage["items"][number]["matchedBy"][number];
type Predicate = { match: Match; condition: SQL };
const all = (conditions: SQL[]) =>
  conditions.length ? sql.join(conditions, sql` AND `) : sql`true`;
const any = (conditions: SQL[]) =>
  conditions.length ? sql.join(conditions, sql` OR `) : sql`false`;

function identityPredicates(q: UsTraceSearchQuery): Predicate[] {
  const p: Predicate[] = [];
  if (q.tlc !== undefined)
    p.push({ match: "tlc", condition: sql`l.tlc COLLATE "C"=${q.tlc} COLLATE "C"` });
  if (q.tlcList !== null)
    p.push({
      match: "tlc",
      condition: sql`l.tlc COLLATE "C"=ANY(${sql.param(q.tlcList)}::text[])`,
    });
  if (q.tlcFrom !== undefined)
    p.push({ match: "tlc", condition: sql`l.tlc COLLATE "C">=${q.tlcFrom} COLLATE "C"` });
  if (q.tlcTo !== undefined)
    p.push({ match: "tlc", condition: sql`l.tlc COLLATE "C"<=${q.tlcTo} COLLATE "C"` });
  if (q.lotId !== undefined) p.push({ match: "lot_id", condition: sql`l.id=${q.lotId}::uuid` });
  if (q.productId !== undefined)
    p.push({ match: "product_id", condition: sql`l.product_id=${q.productId}::uuid` });
  if (q.productText !== undefined)
    p.push({
      match: "product_text_current",
      condition: sql`EXISTS (SELECT 1 FROM products p WHERE p.tenant_id=l.tenant_id AND p.id=l.product_id AND p.name ILIKE ${`%${escapeLikePattern(q.productText)}%`})`,
    });
  if (q.sourceLocationId !== undefined)
    p.push({
      match: "source_location",
      condition: sql`(l.source_location_id=${q.sourceLocationId}::uuid OR l.source_reference_location_id=${q.sourceLocationId}::uuid)`,
    });
  if (q.sourceReferenceValue !== undefined)
    p.push({
      match: "source_reference",
      condition: sql`l.source_reference_value=${q.sourceReferenceValue}`,
    });
  if (q.status !== undefined) p.push({ match: "status", condition: sql`l.status=${q.status}` });
  return p;
}

/** The same-tenant root pointer, finalized state and absence of a successor define current. */
function currentRelations(tenantId: string) {
  return sql`WITH children AS (
    SELECT event_id,lot_id,'receiving' AS type FROM receiving_event_items WHERE tenant_id=${tenantId}
    UNION ALL SELECT event_id,lot_id,'transformation' FROM transformation_event_inputs WHERE tenant_id=${tenantId}
    UNION ALL SELECT event_id,lot_id,'transformation' FROM transformation_event_outputs WHERE tenant_id=${tenantId}
    UNION ALL SELECT event_id,lot_id,'shipping' FROM shipping_event_items WHERE tenant_id=${tenantId}
  ), current_events AS (
    SELECT e.* FROM receiving_event_roots r JOIN traceability_events e
      ON e.tenant_id=r.tenant_id AND e.root_event_id=r.id AND e.id=r.current_event_id AND e.type='receiving'
      WHERE r.tenant_id=${tenantId} AND e.status='finalized' AND e.superseded_by_event_id IS NULL
    UNION ALL SELECT e.* FROM transformation_event_roots r JOIN traceability_events e
      ON e.tenant_id=r.tenant_id AND e.root_event_id=r.id AND e.id=r.current_event_id AND e.type='transformation'
      WHERE r.tenant_id=${tenantId} AND e.status='finalized' AND e.superseded_by_event_id IS NULL
    UNION ALL SELECT e.* FROM shipping_event_roots r JOIN traceability_events e
      ON e.tenant_id=r.tenant_id AND e.root_event_id=r.id AND e.id=r.current_event_id AND e.type='shipping'
      WHERE r.tenant_id=${tenantId} AND e.status='finalized' AND e.superseded_by_event_id IS NULL
  )`;
}

function currentEventExists(conditions: SQL[]) {
  return sql`EXISTS (SELECT 1 FROM current_events e JOIN children c ON c.event_id=e.id AND c.type=e.type
    WHERE c.lot_id=l.id AND (${all(conditions)}))`;
}

function frozenDocument(conditions: (number: SQL, type: SQL) => SQL) {
  const number = sql`CASE WHEN e.type='receiving' THEN d.value->'document'->>'number' ELSE d.value->>'number' END`;
  const type = sql`CASE WHEN e.type='receiving' THEN CASE WHEN d.value->'document'->>'type'='other'
    THEN d.value->'document'->>'typeOtherLabel' ELSE d.value->'document'->>'type' END ELSE d.value->>'type' END`;
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.finalization_snapshot->'documents')='array' THEN e.finalization_snapshot->'documents' ELSE '[]'::jsonb END) d(value) WHERE ${conditions(number, type)})`;
}

function locationParticipant(id: string) {
  // All identifiers are from frozen CTE content, never current location masters.
  return sql`(e.finalization_snapshot->>'locationId'=${id}
    OR e.finalization_snapshot->>'previousSourceLocationId'=${id}
    OR e.finalization_snapshot->'processor'->>'id'=${id}
    OR e.finalization_snapshot->'shipFrom'->>'locationId'=${id}
    OR e.finalization_snapshot->'recipient'->>'locationId'=${id}
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.finalization_snapshot->'items', '[]'::jsonb)
      || COALESCE(e.finalization_snapshot->'inputs', '[]'::jsonb)) line(value)
      WHERE line.value->'source'->>'locationId'=${id} OR line.value->'source'->>'resolvedLocationId'=${id}
        OR line.value->'source'->>'id'=${id}))`;
}

function caseExists(tenantId: string, code: string, state?: "current" | "historical") {
  return sql`EXISTS (SELECT 1 FROM trace_lot_boxes b WHERE b.tenant_id=${tenantId} AND b.lot_id=l.id
    AND b.sscc_at_link=${code} ${state === "current" ? sql`AND b.unlinked_at IS NULL` : state === "historical" ? sql`AND b.unlinked_at IS NOT NULL` : sql``})`;
}

function evidencePredicates(tenantId: string, q: UsTraceSearchQuery) {
  const event: Predicate[] = [];
  if (q.eventType !== undefined)
    event.push({ match: "event_type", condition: sql`e.type=${q.eventType}` });
  if (q.eventDateFrom !== undefined)
    event.push({ match: "event_date", condition: sql`e.event_date>=${q.eventDateFrom}::date` });
  if (q.eventDateTo !== undefined)
    event.push({ match: "event_date", condition: sql`e.event_date<=${q.eventDateTo}::date` });
  if (q.locationId !== undefined)
    event.push({ match: "location", condition: locationParticipant(q.locationId) });
  const doc: Predicate[] = [];
  if (q.documentNumber !== undefined)
    doc.push({
      match: "document_number",
      condition: frozenDocument((number) => sql`${number}=${q.documentNumber}`),
    });
  if (q.documentType !== undefined)
    doc.push({
      match: "document_type",
      condition: frozenDocument((_number, type) => sql`${type}=${q.documentType}`),
    });
  const eventConditions = event.map((p) => p.condition);
  if (doc.length)
    eventConditions.push(
      frozenDocument(
        (number, type) =>
          sql`(${q.documentNumber === undefined ? sql`true` : sql`${number}=${q.documentNumber}`}) AND (${q.documentType === undefined ? sql`true` : sql`${type}=${q.documentType}`})`,
      ),
    );
  const filters: SQL[] = eventConditions.length ? [currentEventExists(eventConditions)] : [];
  const matches: Predicate[] = [...event, ...doc].map((p) => ({
    match: p.match,
    condition: currentEventExists([p.condition]),
  }));
  if (q.sscc !== undefined) {
    filters.push(caseExists(tenantId, q.sscc));
    matches.push(
      { match: "sscc_current", condition: caseExists(tenantId, q.sscc, "current") },
      { match: "sscc_historical", condition: caseExists(tenantId, q.sscc, "historical") },
    );
  }
  if (q.q !== undefined) {
    const free: Predicate[] = [
      { match: "tlc", condition: sql`l.tlc COLLATE "C"=${q.q} COLLATE "C"` },
      { match: "lot_id", condition: sql`l.id::text=${q.q}` },
      { match: "product_id", condition: sql`l.product_id::text=${q.q}` },
      { match: "source_reference", condition: sql`l.source_reference_value=${q.q}` },
      {
        match: "document_number",
        condition: currentEventExists([frozenDocument((number) => sql`${number}=${q.q}`)]),
      },
    ];
    if (isValidSscc(q.q))
      free.push(
        { match: "sscc_current", condition: caseExists(tenantId, q.q, "current") },
        { match: "sscc_historical", condition: caseExists(tenantId, q.q, "historical") },
      );
    filters.push(sql`(${any(free.map((p) => p.condition))})`);
    matches.push(...free);
  }
  return { filters, matches };
}

/** Exported for EXPLAIN of the actual qualification query, with all filters before LIMIT. */
export function traceSearchCandidateQuery(tenantId: string, q: UsTraceSearchQuery) {
  const identity = identityPredicates(q),
    evidence = evidencePredicates(tenantId, q);
  const matches = [...identity, ...evidence.matches];
  const matchSql = matches.length
    ? sql`ARRAY[${sql.join(
        matches.map((p) => sql`CASE WHEN ${p.condition} THEN ${p.match}::text END`),
        sql`, `,
      )}]`
    : sql`ARRAY[]::text[]`;
  return sql`${currentRelations(tenantId)} SELECT l.id,
    to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
    ${matchSql} AS matches
    FROM traceability_lots l WHERE l.tenant_id=${tenantId}
    AND (${all(identity.map((p) => p.condition))}) AND (${all(evidence.filters)})
    ${q.cursor ? sql`AND (l.created_at,l.id)>(${q.cursor.createdAt}::timestamptz,${q.cursor.lotId}::uuid)` : sql``}
    ORDER BY l.created_at,l.id LIMIT ${q.limit + 1}`;
}

type EventSummary = {
  currentCteCount: number;
  firstEventDate: string | null;
  lastEventDate: string | null;
};

/** Only selected lots own this integrity boundary. Page through every direct current event;
 * the internal page size bounds memory/queries, never the legitimate event count.
 */
export async function currentSummaries(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: string[],
  deadline: number,
  onEvent?: (
    event: typeof schema.traceabilityEvents.$inferSelect,
    evidence: TraceEventEvidence,
  ) => void,
) {
  const result = new Map<string, EventSummary>(
    lotIds.map((id) => [id, { currentCteCount: 0, firstEventDate: null, lastEventDate: null }]),
  );
  if (!lotIds.length) return result;
  await assertTraceRelations(tx, tenantId, lotIds);
  const batchSize = 200;
  let after: { id: string; date: string } | undefined;
  for (;;) {
    if (performance.now() > deadline) throw unavailable();
    const page: { rows: { id: string; date: string }[] } = await tx.execute<{
      id: string;
      date: string;
    }>(sql`${currentRelations(tenantId)}
      SELECT e.id,e.event_date::text AS date FROM current_events e
      WHERE EXISTS (SELECT 1 FROM children c WHERE c.event_id=e.id AND c.type=e.type AND c.lot_id=ANY(${sql.param(lotIds)}::uuid[]))
      ${after ? sql`AND (e.event_date,e.id)>(${after.date}::date,${after.id}::uuid)` : sql``}
      ORDER BY e.event_date,e.id LIMIT ${batchSize}`);
    if (!page.rows.length) return result;
    const ids = page.rows.map((row) => row.id);
    const events = await tx
      .select()
      .from(schema.traceabilityEvents)
      .where(
        and(
          eq(schema.traceabilityEvents.tenantId, tenantId),
          inArray(schema.traceabilityEvents.id, ids),
        ),
      );
    if (events.length !== ids.length) throw unavailable();
    const roots = events.map((event) => event.rootEventId);
    // Batch all child/root reads; do not repeat a full history scan per event or hit.
    const receivingRoots = await tx
      .select()
      .from(schema.receivingEventRoots)
      .where(
        and(
          eq(schema.receivingEventRoots.tenantId, tenantId),
          inArray(schema.receivingEventRoots.id, roots),
        ),
      );
    const transformationRoots = await tx
      .select()
      .from(schema.transformationEventRoots)
      .where(
        and(
          eq(schema.transformationEventRoots.tenantId, tenantId),
          inArray(schema.transformationEventRoots.id, roots),
        ),
      );
    const shippingRoots = await tx
      .select()
      .from(schema.shippingEventRoots)
      .where(
        and(
          eq(schema.shippingEventRoots.tenantId, tenantId),
          inArray(schema.shippingEventRoots.id, roots),
        ),
      );
    const receiving = await tx
      .select()
      .from(schema.receivingEventItems)
      .where(
        and(
          eq(schema.receivingEventItems.tenantId, tenantId),
          inArray(schema.receivingEventItems.eventId, ids),
        ),
      )
      .limit(batchSize * 100 + 1);
    const inputs = await tx
      .select()
      .from(schema.transformationEventInputs)
      .where(
        and(
          eq(schema.transformationEventInputs.tenantId, tenantId),
          inArray(schema.transformationEventInputs.eventId, ids),
        ),
      )
      .limit(batchSize * 100 + 1);
    const outputs = await tx
      .select()
      .from(schema.transformationEventOutputs)
      .where(
        and(
          eq(schema.transformationEventOutputs.tenantId, tenantId),
          inArray(schema.transformationEventOutputs.eventId, ids),
        ),
      )
      .limit(batchSize * 100 + 1);
    const shipping = await tx
      .select()
      .from(schema.shippingEventItems)
      .where(
        and(
          eq(schema.shippingEventItems.tenantId, tenantId),
          inArray(schema.shippingEventItems.eventId, ids),
        ),
      )
      .limit(batchSize * 100 + 1);
    const details = await tx
      .select()
      .from(schema.shippingEventDetails)
      .where(
        and(
          eq(schema.shippingEventDetails.tenantId, tenantId),
          inArray(schema.shippingEventDetails.eventId, ids),
        ),
      );
    if ([receiving, inputs, outputs, shipping].some((rows) => rows.length > batchSize * 100))
      throw unavailable();
    for (const event of events) {
      const root = (
        event.type === "receiving"
          ? receivingRoots
          : event.type === "transformation"
            ? transformationRoots
            : shippingRoots
      ).find((row) => row.id === event.rootEventId);
      if (!root) throw unavailable();
      const evidence = validateCurrentTraceEvent(event, root, {
        items: (event.type === "receiving" ? receiving : shipping).filter(
          (row) => row.eventId === event.id,
        ),
        inputs: inputs.filter((row) => row.eventId === event.id),
        outputs: outputs.filter((row) => row.eventId === event.id),
        shippingDetail: details.find((row) => row.eventId === event.id) ?? null,
      });
      onEvent?.(event, evidence);
      for (const lotId of new Set(evidence.lines.map((line) => line.lotId))) {
        const summary = lotId === null ? undefined : result.get(lotId);
        if (!summary) continue;
        summary.currentCteCount++;
        if (summary.firstEventDate === null || evidence.eventDate < summary.firstEventDate)
          summary.firstEventDate = evidence.eventDate;
        if (summary.lastEventDate === null || evidence.eventDate > summary.lastEventDate)
          summary.lastEventDate = evidence.eventDate;
      }
    }
    if (performance.now() > deadline) throw unavailable();
    after = page.rows.at(-1);
    if (page.rows.length < batchSize) return result;
  }
}

async function caseSamples(
  tx: UsMasterDataTransaction,
  tenantId: string,
  ids: string[],
  q: UsTraceSearchQuery,
) {
  const codes = [q.sscc, q.q !== undefined && isValidSscc(q.q) ? q.q : undefined].filter(
    (code): code is string => code !== undefined,
  );
  return tx.execute<{
    lotId: string;
    linkId: string;
    boxId: string;
    ssccAtLink: string;
    state: string;
    provenance: string;
    linkedAt: string;
    unlinkedAt: string | null;
    unlinkReason: string | null;
    position: number;
  }>(sql`WITH links AS (
    SELECT b.*, (b.sscc_at_link=ANY(${sql.param(codes)}::text[])) AS searched,
      row_number() OVER (PARTITION BY b.lot_id,b.sscc_at_link=ANY(${sql.param(codes)}::text[]),b.unlinked_at IS NULL ORDER BY b.linked_at,b.id) AS state_rank
    FROM trace_lot_boxes b WHERE b.tenant_id=${tenantId} AND b.lot_id=ANY(${sql.param(ids)}::uuid[])
  ), ranked AS (
    SELECT b.*,row_number() OVER (PARTITION BY b.lot_id ORDER BY b.searched DESC,b.state_rank,b.linked_at,b.id)::int AS position FROM links b
  ) SELECT b.lot_id AS "lotId",b.id AS "linkId",b.box_id AS "boxId",b.sscc_at_link AS "ssccAtLink",
    CASE WHEN b.unlinked_at IS NULL THEN 'current' ELSE 'historical' END AS state,
    CASE WHEN m.box_id IS NULL THEN 'existing_record' ELSE 'synthetic_demo' END AS provenance,
    to_char(b.linked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "linkedAt",
    to_char(b.unlinked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "unlinkedAt",
    b.unlink_reason AS "unlinkReason",b.position
    FROM ranked b LEFT JOIN traceability_synthetic_case_origins m ON m.tenant_id=${tenantId} AND m.box_id=b.box_id
    WHERE b.position<=21 ORDER BY b.lot_id,b.position`);
}

export async function searchUsTraceability(
  tx: UsMasterDataTransaction,
  tenantId: string,
  query: UsTraceSearchQuery,
): Promise<UsTraceSearchPage> {
  const deadline = performance.now() + 5000;
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
  const candidates = await tx.execute<{ id: string; createdAt: string; matches: (Match | null)[] }>(
    traceSearchCandidateQuery(tenantId, query),
  );
  const selected = candidates.rows.slice(0, query.limit);
  const ids = selected.map((row) => row.id);
  const lots = ids.length
    ? await tx
        .select()
        .from(schema.traceabilityLots)
        .where(
          and(
            eq(schema.traceabilityLots.tenantId, tenantId),
            inArray(schema.traceabilityLots.id, ids),
          ),
        )
    : [];
  const current = await currentSummaries(tx, tenantId, ids, deadline);
  if (lots.length !== ids.length || performance.now() > deadline) throw unavailable();
  const samples = ids.length ? (await caseSamples(tx, tenantId, ids, query)).rows : [];
  const items = selected.map((candidate) => {
    const row = lots.find((lot) => lot.id === candidate.id);
    if (!row) throw unavailable();
    const lot = lotResponse(row);
    const summary = current.get(lot.id);
    if (!summary) throw unavailable();
    const links = samples.filter((sample) => sample.lotId === lot.id);
    return {
      lotId: lot.id,
      tlc: lot.tlc,
      productId: lot.productId,
      source: lot.source,
      status: lot.status,
      matchedBy: [
        ...new Set(candidate.matches.filter((match): match is Match => match !== null)),
      ].sort(),
      ...summary,
      ssccLinks: links.slice(0, 20).map(({ lotId: _lotId, position: _position, ...link }) => link),
      moreCaseHistory: links.length > 20,
    };
  });
  const last = selected.at(-1);
  const appliedFilters = { ...query };
  Reflect.deleteProperty(appliedFilters, "cursor");
  const parsed = usTraceSearchPageSchema.safeParse({
    items,
    appliedFilters,
    rangeOrder: "lexical_c",
    nextCursor:
      candidates.rows.length > query.limit && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, lotId: last.id })).toString(
            "base64url",
          )
        : null,
  });
  if (!parsed.success || performance.now() > deadline) throw unavailable();
  return parsed.data;
}
