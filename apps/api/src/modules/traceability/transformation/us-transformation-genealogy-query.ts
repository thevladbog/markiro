import { schema } from "@markiro/db";
import {
  transformationFinalizationSnapshotV1Schema,
  type TransformationGenealogyResult,
} from "@markiro/platform-contracts";
import { NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readReceivingBasis } from "../receiving/us-receiving-basis";
import { readCurrentTransformationOrigin } from "./us-transformation-origin";
import { unavailable } from "./us-transformation-persistence";

export type GenealogyEvent = TransformationGenealogyResult["events"][number];
export const sortedIds = (ids: Iterable<string>) => [...new Set(ids)].sort();
const list = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/** Begin with children so a missing or wrong-type parent cannot hide evidence. */
async function assertLotRelations(tx: UsMasterDataTransaction, tenantId: string, lotIds: string[]) {
  if (!lotIds.length) return;
  const ids = sql`${sql.param(sortedIds(lotIds))}::uuid[]`;
  const result = await tx.execute<{ invalid: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT event_id FROM transformation_event_inputs WHERE tenant_id=${tenantId} AND lot_id=ANY(${ids})
        UNION ALL
        SELECT event_id FROM transformation_event_outputs WHERE tenant_id=${tenantId} AND lot_id=ANY(${ids})
        UNION ALL
        SELECT event_id FROM lot_genealogy_edges WHERE tenant_id=${tenantId}
          AND (input_lot_id=ANY(${ids}) OR output_lot_id=ANY(${ids}))
      ) child
      LEFT JOIN traceability_events e ON e.tenant_id=${tenantId} AND e.id=child.event_id
      LEFT JOIN transformation_event_roots r ON r.tenant_id=${tenantId} AND r.id=e.root_event_id
      WHERE e.id IS NULL OR e.type<>'transformation' OR r.id IS NULL
    ) AS invalid
  `);
  if (result.rows[0]?.invalid !== false) throw unavailable();
}

/** Scope integrity checks to roots touched by the frontier, including historical/void outputs.
 * EXISTS checks do not materialize tenant history or lock business rows.
 */
async function assertRoots(tx: UsMasterDataTransaction, tenantId: string, scope: SQL) {
  const result = await tx.execute<{ invalid: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM traceability_events e
      LEFT JOIN transformation_event_roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id
      WHERE e.tenant_id=${tenantId} AND (${scope}) AND (
        e.type<>'transformation' OR r.id IS NULL OR e.event_number<>r.event_number
        OR e.revision>=r.next_revision
        OR (e.revision=1 AND (e.id<>r.id OR e.previous_revision_id IS NOT NULL))
        OR (e.revision>1 AND NOT EXISTS (
          SELECT 1 FROM traceability_events p WHERE p.tenant_id=${tenantId} AND p.id=e.previous_revision_id
            AND p.root_event_id=e.root_event_id AND p.type='transformation' AND p.revision<e.revision
            AND p.finalization_snapshot IS NOT NULL))
        OR (e.status='finalized' AND (r.current_event_id IS DISTINCT FROM e.id OR e.superseded_by_event_id IS NOT NULL))
        OR (e.status='draft' AND r.pending_draft_id IS DISTINCT FROM e.id)
        OR (r.current_event_id=e.id AND (e.status<>'finalized' OR e.superseded_by_event_id IS NOT NULL))
        OR (r.pending_draft_id=e.id AND e.status<>'draft')
        OR (r.current_event_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM traceability_events c WHERE c.tenant_id=${tenantId} AND c.root_event_id=r.id
            AND c.id=r.current_event_id AND c.type='transformation' AND c.status='finalized' AND c.superseded_by_event_id IS NULL))
        OR (e.status='amended' AND NOT EXISTS (
          SELECT 1 FROM traceability_events s WHERE s.tenant_id=${tenantId} AND s.root_event_id=r.id
            AND s.id=e.superseded_by_event_id AND s.previous_revision_id=e.id AND s.revision>e.revision
            AND s.type='transformation' AND s.finalization_snapshot IS NOT NULL))
      )
    ) AS invalid
  `);
  if (result.rows[0]?.invalid !== false) throw unavailable();
}

export async function currentFrontierEvents(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: string[],
  direction: "upstream" | "downstream",
  limit: number,
) {
  await assertLotRelations(tx, tenantId, lotIds);
  const ids = list(sortedIds(lotIds));
  const scope =
    direction === "upstream"
      ? sql`(EXISTS (SELECT 1 FROM transformation_event_outputs o WHERE o.tenant_id=${tenantId} AND o.event_id=e.id AND o.lot_id IN (${ids}))
        OR EXISTS (SELECT 1 FROM lot_genealogy_edges g WHERE g.tenant_id=${tenantId} AND g.event_id=e.id AND g.output_lot_id IN (${ids})))`
      : sql`(EXISTS (SELECT 1 FROM transformation_event_inputs i WHERE i.tenant_id=${tenantId} AND i.event_id=e.id AND i.lot_id IN (${ids}))
        OR EXISTS (SELECT 1 FROM lot_genealogy_edges g WHERE g.tenant_id=${tenantId} AND g.event_id=e.id AND g.input_lot_id IN (${ids})))`;
  await assertRoots(tx, tenantId, scope);
  const result = await tx.execute<{ id: string }>(sql`
    SELECT e.id FROM traceability_events e
    JOIN transformation_event_roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id AND r.current_event_id=e.id
    WHERE e.tenant_id=${tenantId} AND e.type='transformation' AND e.status='finalized'
      AND e.superseded_by_event_id IS NULL AND (${scope}) ORDER BY e.id LIMIT ${limit}
  `);
  return result.rows.map((row) => row.id);
}

export async function genealogyEvents(
  tx: UsMasterDataTransaction,
  tenantId: string,
  ids: string[],
  current: boolean,
): Promise<GenealogyEvent[]> {
  if (!ids.length) return [];
  const events = schema.traceabilityEvents;
  const rows = await tx
    .select()
    .from(events)
    .where(
      and(
        eq(events.tenantId, tenantId),
        eq(events.type, "transformation"),
        inArray(events.id, sortedIds(ids)),
      ),
    )
    .orderBy(asc(events.id));
  if (
    rows.length !== ids.length ||
    rows.some((row) => !["finalized", "amended", "void"].includes(row.status))
  )
    throw new NotFoundException({ code: "transformation_not_found" });
  await assertRoots(tx, tenantId, sql`e.id IN (${list(sortedIds(ids))})`);
  const result = rows.map((row): GenealogyEvent => {
    if (row.status !== "finalized" && row.status !== "amended" && row.status !== "void")
      throw unavailable();
    if (current && (row.status !== "finalized" || row.supersededByEventId !== null))
      throw unavailable();
    if (row.finalizationSnapshot === null) {
      if (row.status !== "void" || row.finalizedAt !== null || row.finalizedBy !== null)
        throw unavailable();
      return {
        id: row.id,
        rootId: row.rootEventId,
        revision: row.revision,
        status: row.status,
        snapshot: null,
      };
    }
    const parsed = transformationFinalizationSnapshotV1Schema.safeParse(row.finalizationSnapshot);
    if (
      !parsed.success ||
      parsed.data.eventId !== row.id ||
      parsed.data.revision !== row.revision ||
      parsed.data.eventNumber !== row.eventNumber ||
      (parsed.data.previousRevisionId ?? null) !== row.previousRevisionId
    )
      throw unavailable();
    return {
      id: row.id,
      rootId: row.rootEventId,
      revision: row.revision,
      status: row.status,
      snapshot: parsed.data,
    };
  });
  // Zero-edge events cannot rely on edge parity to catch a corrupt saved lot
  // binding. Compare against immutable typed lines, never live master data.
  const integrity = await tx.execute<{ invalid: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM traceability_events e
      WHERE e.tenant_id=${tenantId} AND e.type='transformation' AND e.id IN (${list(sortedIds(ids))})
        AND e.finalization_snapshot IS NOT NULL AND (
          jsonb_array_length(e.finalization_snapshot->'inputs')<>(SELECT count(*) FROM transformation_event_inputs i WHERE i.tenant_id=${tenantId} AND i.event_id=e.id)
          OR jsonb_array_length(e.finalization_snapshot->'outputs')<>(SELECT count(*) FROM transformation_event_outputs o WHERE o.tenant_id=${tenantId} AND o.event_id=e.id)
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(e.finalization_snapshot->'inputs') line
            LEFT JOIN transformation_event_inputs i ON i.tenant_id=${tenantId} AND i.event_id=e.id AND i.line_no=(line->>'lineNo')::integer
            WHERE i.event_id IS NULL OR i.kind IS DISTINCT FROM line->>'kind'
              OR i.lot_id::text IS DISTINCT FROM line->>'lotId'
              OR i.quantity IS DISTINCT FROM line->>'quantity' OR i.unit_of_measure IS DISTINCT FROM line->>'unitOfMeasure'
              OR (i.kind='non_ftl' AND (i.product_id::text IS DISTINCT FROM line->'product'->>'id'
                OR i.source_location_id::text IS DISTINCT FROM line->'source'->>'id' OR i.reference IS DISTINCT FROM line->>'reference'))
          )
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(e.finalization_snapshot->'outputs') line
            LEFT JOIN transformation_event_outputs o ON o.tenant_id=${tenantId} AND o.event_id=e.id AND o.line_no=(line->>'lineNo')::integer
            WHERE o.event_id IS NULL OR o.lot_id::text IS DISTINCT FROM line->>'lotId'
              OR o.product_id::text IS DISTINCT FROM line->'product'->>'id' OR o.tlc IS DISTINCT FROM line->>'tlc'
              OR o.quantity IS DISTINCT FROM line->>'quantity' OR o.unit_of_measure IS DISTINCT FROM line->>'unitOfMeasure'
          )
        )
    ) AS invalid
  `);
  if (integrity.rows[0]?.invalid !== false) throw unavailable();
  return result;
}

export async function genealogyEdges(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventIds: string[],
  current: boolean,
) {
  if (!eventIds.length) return [];
  // Even after event validation, current edge reads corroborate the typed root pointer.
  const result = await tx.execute<TransformationGenealogyResult["links"][number]>(sql`
    SELECT g.event_id AS "eventId",g.input_lot_id AS "inputLotId",g.output_lot_id AS "outputLotId"
    FROM lot_genealogy_edges g
    JOIN traceability_events e ON e.tenant_id=g.tenant_id AND e.id=g.event_id AND e.type='transformation'
    JOIN transformation_event_roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id
    WHERE g.tenant_id=${tenantId} AND g.event_id IN (${list(sortedIds(eventIds))})
      ${current ? sql`AND r.current_event_id=e.id AND e.status='finalized' AND e.superseded_by_event_id IS NULL` : sql``}
    ORDER BY g.event_id,g.input_lot_id,g.output_lot_id LIMIT 2001
  `);
  return result.rows;
}

export async function genealogyLotIds(
  tx: UsMasterDataTransaction,
  tenantId: string,
  ids: string[],
) {
  if (!ids.length) return [];
  await assertLotRelations(tx, tenantId, ids);
  const lots = schema.traceabilityLots;
  return tx
    .select({ id: lots.id })
    .from(lots)
    .where(and(eq(lots.tenantId, tenantId), inArray(lots.id, sortedIds(ids))))
    .orderBy(asc(lots.id));
}

export async function genealogyLots(tx: UsMasterDataTransaction, tenantId: string, ids: string[]) {
  const result: TransformationGenealogyResult["lots"] = [];
  for (const lotId of sortedIds(ids)) {
    await assertRoots(
      tx,
      tenantId,
      sql`EXISTS (SELECT 1 FROM transformation_event_outputs o WHERE o.tenant_id=${tenantId} AND o.event_id=e.id AND o.lot_id=${lotId})`,
    );
    const origin = await readCurrentTransformationOrigin(tx, tenantId, lotId);
    if (origin.eventId) await genealogyEvents(tx, tenantId, [origin.eventId], true);
    // Receiving is an existing evidence source, not a synthetic Transformation.
    const receiving = await readReceivingBasis(tx, tenantId, lotId, { limit: 1, offset: 0 });
    result.push({ id: lotId, currentOrigin: origin.currentOrigin || receiving.supportCount > 0 });
  }
  return result;
}
