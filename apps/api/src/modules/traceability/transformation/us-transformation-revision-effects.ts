import { schema } from "@markiro/db";
import { classifyTransformationChange, sameTransformationOutputIdentity } from "@markiro/domain";
import type { TransformationDraftRecord } from "@markiro/platform-contracts";
import { ConflictException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { listCurrentDownstreamConsumers } from "../shipping/us-shipping-balance";
import { readTransformationSavedDraft, unavailable } from "./us-transformation-persistence";

export async function lockTransformationLots(
  tx: UsMasterDataTransaction,
  tenantId: string,
  ids: readonly string[],
) {
  const sorted = [...new Set(ids)].sort();
  if (!sorted.length) return [];
  const lots = schema.traceabilityLots;
  const rows = await tx
    .select()
    .from(lots)
    .where(and(eq(lots.tenantId, tenantId), inArray(lots.id, sorted)))
    .orderBy(asc(lots.id))
    .for("update");
  if (rows.length !== sorted.length) throw unavailable();
  return rows;
}
export async function assertNoTransformationConsumers(
  tx: UsMasterDataTransaction,
  tenantId: string,
  outputIds: readonly string[],
) {
  const blockers = await listCurrentDownstreamConsumers(tx, tenantId, outputIds);
  if (blockers.length)
    throw new ConflictException({ code: "traceability_downstream_blocked", blockers });
}

/** Root is already locked. Do not lock another root after acquiring lot locks. */
export async function prepareTransformationRevision(
  tx: UsMasterDataTransaction,
  tenantId: string,
  saved: TransformationDraftRecord,
) {
  const inputIds = saved.draft.inputs.flatMap((line) =>
    line.kind === "ftl_lot" && line.lotId ? [line.lotId] : [],
  );
  const lifecycle = saved.lifecycle;
  if (!lifecycle || lifecycle.pendingDraftId !== saved.id) throw unavailable();
  if (saved.revision === 1) {
    await lockTransformationLots(tx, tenantId, inputIds);
    return { outputLotIds: undefined, affectedLotIds: inputIds };
  }
  const events = schema.traceabilityEvents;
  const [prior] = await tx
    .select()
    .from(events)
    .where(
      and(
        eq(events.tenantId, tenantId),
        eq(events.id, lifecycle.previousRevisionId ?? saved.id),
        eq(events.type, "transformation"),
      ),
    )
    .for("update");
  if (
    !prior ||
    prior.rootEventId !== lifecycle.rootId ||
    prior.status !== "finalized" ||
    prior.supersededByEventId !== null ||
    prior.id !== lifecycle.currentEventId
  )
    throw new ConflictException({ code: "transformation_lifecycle_conflict" });
  const oldDraft = await readTransformationSavedDraft(tx, tenantId, prior.id, prior);
  const outputs = schema.transformationEventOutputs;
  const rows = await tx
    .select()
    .from(outputs)
    .where(and(eq(outputs.tenantId, tenantId), inArray(outputs.eventId, [saved.id, prior.id])))
    .orderBy(asc(outputs.lineNo));
  const bound = rows.filter((row) => row.eventId === saved.id);
  const priorBound = rows.filter((row) => row.eventId === prior.id);
  if (
    oldDraft.processorLocationId !== saved.draft.processorLocationId ||
    !sameTransformationOutputIdentity(oldDraft.outputs, saved.draft.outputs) ||
    bound.length !== priorBound.length ||
    bound.some(
      (line, index) =>
        !line.lotId ||
        line.lotId !== priorBound[index]?.lotId ||
        line.lineNo !== priorBound[index]?.lineNo,
    )
  )
    throw new ConflictException({ code: "transformation_output_identity_locked" });
  const outputLotIds = bound.map((line) => {
    if (!line.lotId) throw unavailable();
    return line.lotId;
  });
  const affectedLotIds = [
    ...new Set([
      ...inputIds,
      ...outputLotIds,
      ...oldDraft.inputs.flatMap((line) =>
        line.kind === "ftl_lot" && line.lotId ? [line.lotId] : [],
      ),
    ]),
  ];
  const lots = await lockTransformationLots(tx, tenantId, affectedLotIds);
  for (const line of bound) {
    const lot = lots.find((lot) => lot.id === line.lotId);
    if (
      !lot ||
      lot.productId !== line.productId ||
      lot.tlc !== line.tlc ||
      lot.sourceLocationId !== prior.locationId ||
      lot.assignmentBasis !== "transformation" ||
      lot.sourceLockedAt === null
    )
      throw new ConflictException({ code: "transformation_output_identity_locked" });
  }
  await assertAcyclicTransformationReplacement(tx, tenantId, prior.id, inputIds, outputLotIds);
  if (classifyTransformationChange(oldDraft, saved.draft) === "material")
    await assertNoTransformationConsumers(tx, tenantId, outputLotIds);
  return { outputLotIds, affectedLotIds };
}

async function assertAcyclicTransformationReplacement(
  tx: UsMasterDataTransaction,
  tenantId: string,
  predecessorId: string,
  inputs: string[],
  outputs: string[],
) {
  if (!inputs.length || !outputs.length) return;
  // UNION (not UNION ALL) bounds traversal even if existing data contains a cycle.
  const result = await tx.execute<{ cycle: boolean }>(sql`
    WITH RECURSIVE current_edges AS (
      SELECT g.input_lot_id,g.output_lot_id FROM lot_genealogy_edges g
      JOIN traceability_events e ON e.tenant_id=g.tenant_id AND e.id=g.event_id AND e.type='transformation'
      JOIN transformation_event_roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id AND r.current_event_id=e.id
      WHERE g.tenant_id=${tenantId} AND e.status='finalized' AND e.superseded_by_event_id IS NULL AND e.id<>${predecessorId}
    ), reachable(lot_id) AS (
      SELECT unnest(ARRAY[${sql.join(
        outputs.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}])
      UNION SELECT g.output_lot_id FROM current_edges g JOIN reachable r ON r.lot_id=g.input_lot_id
    ) SELECT EXISTS(SELECT 1 FROM reachable WHERE lot_id IN (${sql.join(
      inputs.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})) AS cycle
  `);
  if (result.rows[0]?.cycle)
    throw new ConflictException({ code: "transformation_genealogy_cycle" });
}
