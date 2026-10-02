import { isDeepStrictEqual } from "node:util";
import { schema } from "@markiro/db";
import {
  receivingFinalizationSnapshotSchema,
  receivingFinalizationSnapshotV3Schema,
  provisionUsTraceabilityProfileSchema,
  shippingFinalizationSnapshotV1Schema,
  transformationFinalizationSnapshotV1Schema,
} from "@markiro/platform-contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "../receiving/us-receiving-persistence";
import {
  assertTraceRelations,
  traceCandidateQuery,
  traceRelations,
  type TraceDirection,
} from "./us-trace-query";

export type { TraceDirection } from "./us-trace-query";
export type TraceLine = {
  side: "receiving" | "input" | "output" | "shipping";
  lineNo: number;
  lotId: string | null;
  nodeId: string;
  quantity: string | null;
  unitOfMeasure: string | null;
  display: string;
  tlc: string | null;
};
export type TraceEventEvidence = {
  id: string;
  rootId: string;
  type: "receiving" | "transformation" | "shipping";
  eventNumber: string;
  revision: number;
  eventDate: string;
  timeZone: string;
  display: string;
  lines: readonly TraceLine[];
};
export type TraceFrontierPage = { events: readonly TraceEventEvidence[]; hasMore: boolean };
type Event = typeof schema.traceabilityEvents.$inferSelect;
type Root = Pick<
  typeof schema.receivingEventRoots.$inferSelect,
  "id" | "tenantId" | "currentEventId" | "eventNumber" | "nextRevision"
>;
type Children = {
  shippingDetail?: typeof schema.shippingEventDetails.$inferSelect | null;
  items: readonly (
    typeof schema.receivingEventItems.$inferSelect | typeof schema.shippingEventItems.$inferSelect
  )[];
  inputs: readonly (typeof schema.transformationEventInputs.$inferSelect)[];
  outputs: readonly (typeof schema.transformationEventOutputs.$inferSelect)[];
};

/** Pure integrity boundary: no mutable master-data descriptions can enter this projection. */
export function validateCurrentTraceEvent(
  row: Event,
  root: Root,
  children: Children,
): TraceEventEvidence {
  if (
    root.tenantId !== row.tenantId ||
    root.id !== row.rootEventId ||
    root.currentEventId !== row.id ||
    root.eventNumber !== row.eventNumber ||
    row.revision >= root.nextRevision ||
    row.status !== "finalized" ||
    row.supersededByEventId !== null ||
    row.dateReceived === null ||
    row.finalizedAt === null ||
    row.finalizedBy === null ||
    !provisionUsTraceabilityProfileSchema.shape.timeZone.safeParse(row.timeZone).success
  )
    throw unavailable();
  const base = {
    id: row.id,
    rootId: row.rootEventId,
    eventNumber: row.eventNumber,
    revision: row.revision,
    eventDate: row.dateReceived,
    timeZone: row.timeZone,
  };
  const matches = (
    line: { lineNo: number; lotId?: string; quantity: string; unitOfMeasure: string },
    rows: readonly {
      tenantId: string;
      eventId: string;
      lineNo: number;
      lotId: string | null;
      quantity: string | null;
      unitOfMeasure: string | null;
    }[],
  ) => {
    const child = rows.find((item) => item.lineNo === line.lineNo);
    if (
      !child ||
      child.tenantId !== row.tenantId ||
      child.eventId !== row.id ||
      child.lotId !== (line.lotId ?? null) ||
      child.quantity !== line.quantity ||
      child.unitOfMeasure !== line.unitOfMeasure
    )
      throw unavailable();
    return child;
  };
  if (row.type === "receiving") {
    const legacy = receivingFinalizationSnapshotSchema.safeParse(row.finalizationSnapshot);
    const parsed = legacy.success
      ? legacy
      : receivingFinalizationSnapshotV3Schema.safeParse(row.finalizationSnapshot);
    if (
      !parsed.success ||
      parsed.data.dateReceived !== row.dateReceived ||
      parsed.data.locationId !== row.locationId ||
      parsed.data.previousSourceLocationId !== row.previousSourceLocationId ||
      parsed.data.items.length !== children.items.length
    )
      throw unavailable();
    const snapshot = parsed.data;
    return {
      ...base,
      type: "receiving",
      display: snapshot.previousSourceDescription.businessName,
      lines: snapshot.items.map((line) => {
        matches(line, children.items);
        const child = children.items.find((item) => item.lineNo === line.lineNo);
        if (
          !child ||
          !("productId" in child) ||
          child.productId !== line.productId ||
          child.lotLinkMode !== line.lotLinkMode ||
          child.tlc !== line.tlc ||
          (line.source.kind === "location"
            ? child.sourceLocationId !== line.source.locationId
            : child.sourceReferenceKind !== line.source.referenceKind ||
              child.sourceReferenceValue !== line.source.referenceValue ||
              child.sourceReferenceLocationId !== line.source.resolvedLocationId)
        )
          throw unavailable();
        const binding =
          snapshot.snapshotVersion === 3
            ? snapshot.items.find((item) => item.lineNo === line.lineNo)?.lotBinding
            : undefined;
        if ((binding?.kind === "retained") !== (child.previousLineNo !== null)) throw unavailable();
        if (
          binding?.kind === "retained" &&
          (child.previousLineNo !== binding.previousLineNo ||
            row.previousRevisionId !== binding.previousEventId)
        )
          throw unavailable();
        return {
          side: "receiving",
          lineNo: line.lineNo,
          lotId: line.lotId,
          nodeId: `location:${snapshot.previousSourceDescription.locationId}`,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
          display: snapshot.previousSourceDescription.businessName,
          tlc: line.tlc,
        };
      }),
    };
  }
  if (row.type === "transformation") {
    const parsed = transformationFinalizationSnapshotV1Schema.safeParse(row.finalizationSnapshot);
    if (!parsed.success) throw unavailable();
    const s = parsed.data;
    if (
      s.eventId !== row.id ||
      s.eventNumber !== row.eventNumber ||
      s.revision !== row.revision ||
      s.eventDate !== row.dateReceived ||
      s.timeZone !== row.timeZone ||
      (s.previousRevisionId ?? null) !== row.previousRevisionId ||
      s.processor.id !== row.locationId ||
      s.inputs.length !== children.inputs.length ||
      s.outputs.length !== children.outputs.length
    )
      throw unavailable();
    const inputs = s.inputs.map((line): TraceLine => {
      matches(line, children.inputs);
      const child = children.inputs.find((item) => item.lineNo === line.lineNo);
      if (
        !child ||
        child.kind !== line.kind ||
        (line.kind === "non_ftl" &&
          (child.productId !== line.product.id ||
            child.sourceLocationId !== line.source.id ||
            child.reference !== line.reference))
      )
        throw unavailable();
      return {
        side: "input",
        lineNo: line.lineNo,
        lotId: line.kind === "ftl_lot" ? line.lotId : null,
        nodeId: line.kind === "ftl_lot" ? `lot:${line.lotId}` : `material:${row.id}:${line.lineNo}`,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        display: line.product.description,
        tlc: line.kind === "ftl_lot" ? line.tlc : null,
      };
    });
    const outputs = s.outputs.map((line): TraceLine => {
      matches(line, children.outputs);
      const child = children.outputs.find((item) => item.lineNo === line.lineNo);
      if (!child || child.productId !== line.product.id || child.tlc !== line.tlc)
        throw unavailable();
      return {
        side: "output",
        lineNo: line.lineNo,
        lotId: line.lotId,
        nodeId: `lot:${line.lotId}`,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        display: line.product.description,
        tlc: line.tlc,
      };
    });
    return {
      ...base,
      type: "transformation",
      display: s.processor.description,
      lines: [...inputs, ...outputs],
    };
  }
  if (row.type === "shipping") {
    const parsed = shippingFinalizationSnapshotV1Schema.safeParse(row.finalizationSnapshot);
    if (!parsed.success) throw unavailable();
    const s = parsed.data;
    if (
      s.eventId !== row.id ||
      s.eventNumber !== row.eventNumber ||
      s.revision !== row.revision ||
      s.eventDate !== row.dateReceived ||
      s.timeZone !== row.timeZone ||
      (s.previousRevisionId ?? null) !== row.previousRevisionId ||
      s.shipFrom.locationId !== row.locationId ||
      s.items.length !== children.items.length
    )
      throw unavailable();
    const detail = children.shippingDetail;
    // Preserve the existing persisted flat compatibility keys and typed location.
    const recipient = s.recipient;
    const address =
      recipient.address.kind === "street"
        ? recipient.address.streetAddress
        : `${recipient.address.latitude}, ${recipient.address.longitude}`;
    const recipientSnapshot = {
      id: recipient.locationId,
      description: [
        recipient.businessName,
        address,
        recipient.city,
        recipient.stateOrRegion,
        recipient.zipOrPostalCode,
        recipient.countryDisplay,
        recipient.phoneNumber,
      ].join(", "),
      location: recipient,
    };
    if (
      !detail ||
      detail.tenantId !== row.tenantId ||
      detail.eventId !== row.id ||
      detail.recipientLocationId !== recipient.locationId ||
      !isDeepStrictEqual(detail.recipientSnapshot, recipientSnapshot)
    )
      throw unavailable();
    return {
      ...base,
      type: "shipping",
      display: s.recipient.businessName,
      lines: s.items.map((line) => {
        matches(line, children.items);
        const child = children.items.find((item) => item.lineNo === line.lineNo);
        if (
          !child ||
          !("tlcSnapshot" in child) ||
          child.tlcSnapshot !== line.tlc ||
          !isDeepStrictEqual(child.sourceSnapshot, line.source) ||
          !isDeepStrictEqual(child.productSnapshot, line.product)
        )
          throw unavailable();
        return {
          side: "shipping",
          lineNo: line.lineNo,
          lotId: line.lotId,
          nodeId: `location:${s.recipient.locationId}`,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
          display: s.recipient.businessName,
          tlc: line.tlc,
        };
      }),
    };
  }
  throw unavailable();
}

export async function loadAndValidateFrozenEvents(
  tx: UsMasterDataTransaction,
  tenantId: string,
  ids: string[],
): Promise<TraceEventEvidence[]> {
  if (!ids.length) return [];
  const rows = await tx
    .select()
    .from(schema.traceabilityEvents)
    .where(
      and(
        eq(schema.traceabilityEvents.tenantId, tenantId),
        inArray(schema.traceabilityEvents.id, ids),
      ),
    );
  if (rows.length !== ids.length) throw unavailable();
  const result: TraceEventEvidence[] = [];
  for (const id of ids) {
    const row = rows.find((item) => item.id === id);
    if (!row) throw unavailable();
    const table =
      row.type === "receiving"
        ? schema.receivingEventRoots
        : row.type === "transformation"
          ? schema.transformationEventRoots
          : schema.shippingEventRoots;
    const [root] = await tx
      .select()
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(table.id, row.rootEventId)));
    if (!root) throw unavailable();
    const children: Children = { items: [], inputs: [], outputs: [] };
    if (row.type === "transformation") {
      const i = schema.transformationEventInputs,
        o = schema.transformationEventOutputs;
      children.inputs = await tx
        .select()
        .from(i)
        .where(and(eq(i.tenantId, tenantId), eq(i.eventId, id)))
        .limit(101);
      children.outputs = await tx
        .select()
        .from(o)
        .where(and(eq(o.tenantId, tenantId), eq(o.eventId, id)))
        .limit(101);
    } else if (row.type === "receiving") {
      const i = schema.receivingEventItems;
      children.items = await tx
        .select()
        .from(i)
        .where(and(eq(i.tenantId, tenantId), eq(i.eventId, id)))
        .limit(101);
    } else {
      const i = schema.shippingEventItems;
      children.items = await tx
        .select()
        .from(i)
        .where(and(eq(i.tenantId, tenantId), eq(i.eventId, id)))
        .limit(101);
      const detail = schema.shippingEventDetails;
      const [savedDetail] = await tx
        .select()
        .from(detail)
        .where(and(eq(detail.tenantId, tenantId), eq(detail.eventId, id)));
      children.shippingDetail = savedDetail ?? null;
    }
    result.push(validateCurrentTraceEvent(row, root, children));
  }
  return result;
}

export async function readCurrentTraceFrontier(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: readonly string[],
  direction: TraceDirection,
  limit: number,
): Promise<TraceFrontierPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000 || lotIds.length > 500)
    throw unavailable();
  if (!lotIds.length) return { events: [], hasMore: false };
  await assertTraceRelations(tx, tenantId, lotIds);
  const candidates = await tx.execute<{ id: string }>(
    traceCandidateQuery(tenantId, lotIds, direction, limit),
  );
  const events = await loadAndValidateFrozenEvents(
    tx,
    tenantId,
    candidates.rows.slice(0, limit).map((row) => row.id),
  );
  return { events, hasMore: candidates.rows.length > limit };
}

export async function assertCurrentTraceOrigin(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: readonly string[],
): Promise<Set<string>> {
  if (lotIds.length > 500) throw unavailable();
  if (!lotIds.length) return new Set();
  await assertTraceRelations(tx, tenantId, lotIds);
  const result = await tx.execute<{ lotId: string }>(sql`${traceRelations(tenantId, lotIds)}
    SELECT DISTINCT c.lot_id AS "lotId" FROM children c
    JOIN traceability_events e ON e.tenant_id=${tenantId} AND e.id=c.event_id AND e.type=c.type
    JOIN roots r ON r.id=e.root_event_id AND r.type=e.type AND r.current_event_id=e.id
    WHERE c.direction='backward' AND e.status='finalized' AND e.superseded_by_event_id IS NULL`);
  return new Set(result.rows.map((row) => row.lotId));
}
