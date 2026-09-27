import { schema } from "@markiro/db";
import {
  UOM_CODES_V1,
  computeShippingBalance,
  type ShippingBalance,
  type TraceabilityUom,
} from "@markiro/domain";
import { ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import {
  listCurrentTransformationConsumers,
  type CurrentConsumer,
} from "../lots/us-current-consumers";

const unavailable = () => new ServiceUnavailableException({ code: "us_database_unavailable" });

type QuantityRow = {
  eventId: string | null;
  quantity: string | null;
  unitOfMeasure: string | null;
  type: string | null;
  status: string | null;
  supersededByEventId: string | null;
  currentEventId: string | null;
  rootId: string | null;
};

/** A current pointer is authoritative; a historical revision must never be summed. */
function current(rows: QuantityRow[], type: string, excludedEventId?: string) {
  return rows.flatMap((row) => {
    if (!row.eventId || !row.type || !row.rootId || row.type !== type) throw unavailable();
    if (row.currentEventId !== row.eventId || row.eventId === excludedEventId) return [];
    if (row.status !== "finalized" || row.supersededByEventId !== null) throw unavailable();
    return [{ quantity: row.quantity ?? "", unitOfMeasure: row.unitOfMeasure ?? "" }];
  });
}

/** Caller holds this exact tenant lot's row lock before requesting a decision. */
export async function readCurrentShippingBalance(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  excludedShippingEventId?: string,
): Promise<ShippingBalance> {
  return (await readCurrentShippingBalanceProjection(tx, tenantId, lotId, excludedShippingEventId))
    .balance;
}

/** Same locked snapshot as the finalization balance, with origin UOM retained separately. */
export async function readCurrentShippingBalanceProjection(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  excludedShippingEventId?: string,
): Promise<{ originUom: TraceabilityUom | null; balance: ShippingBalance }> {
  const events = schema.traceabilityEvents;
  const receiving = schema.receivingEventItems;
  const transformationInputs = schema.transformationEventInputs;
  const transformationOutputs = schema.transformationEventOutputs;
  const shipping = schema.shippingEventItems;
  const receivingRoots = schema.receivingEventRoots;
  const transformationRoots = schema.transformationEventRoots;
  const shippingRoots = schema.shippingEventRoots;
  const select = {
    eventId: events.id,
    type: events.type,
    status: events.status,
    supersededByEventId: events.supersededByEventId,
  };
  const receipts = await tx
    .select({
      ...select,
      quantity: receiving.quantity,
      unitOfMeasure: receiving.unitOfMeasure,
      currentEventId: receivingRoots.currentEventId,
      rootId: receivingRoots.id,
    })
    .from(receiving)
    .leftJoin(
      events,
      and(eq(events.tenantId, receiving.tenantId), eq(events.id, receiving.eventId)),
    )
    .leftJoin(
      receivingRoots,
      and(
        eq(receivingRoots.tenantId, receiving.tenantId),
        eq(receivingRoots.id, events.rootEventId),
      ),
    )
    .where(and(eq(receiving.tenantId, tenantId), eq(receiving.lotId, lotId)));
  const outputs = await tx
    .select({
      ...select,
      quantity: transformationOutputs.quantity,
      unitOfMeasure: transformationOutputs.unitOfMeasure,
      currentEventId: transformationRoots.currentEventId,
      rootId: transformationRoots.id,
    })
    .from(transformationOutputs)
    .leftJoin(
      events,
      and(
        eq(events.tenantId, transformationOutputs.tenantId),
        eq(events.id, transformationOutputs.eventId),
      ),
    )
    .leftJoin(
      transformationRoots,
      and(
        eq(transformationRoots.tenantId, transformationOutputs.tenantId),
        eq(transformationRoots.id, events.rootEventId),
      ),
    )
    .where(
      and(eq(transformationOutputs.tenantId, tenantId), eq(transformationOutputs.lotId, lotId)),
    );
  const inputs = await tx
    .select({
      ...select,
      quantity: transformationInputs.quantity,
      unitOfMeasure: transformationInputs.unitOfMeasure,
      currentEventId: transformationRoots.currentEventId,
      rootId: transformationRoots.id,
    })
    .from(transformationInputs)
    .leftJoin(
      events,
      and(
        eq(events.tenantId, transformationInputs.tenantId),
        eq(events.id, transformationInputs.eventId),
      ),
    )
    .leftJoin(
      transformationRoots,
      and(
        eq(transformationRoots.tenantId, transformationInputs.tenantId),
        eq(transformationRoots.id, events.rootEventId),
      ),
    )
    .where(
      and(
        eq(transformationInputs.tenantId, tenantId),
        eq(transformationInputs.lotId, lotId),
        eq(transformationInputs.kind, "ftl_lot"),
      ),
    );
  const shipments = await tx
    .select({
      ...select,
      quantity: shipping.quantity,
      unitOfMeasure: shipping.unitOfMeasure,
      currentEventId: shippingRoots.currentEventId,
      rootId: shippingRoots.id,
    })
    .from(shipping)
    .leftJoin(events, and(eq(events.tenantId, shipping.tenantId), eq(events.id, shipping.eventId)))
    .leftJoin(
      shippingRoots,
      and(eq(shippingRoots.tenantId, shipping.tenantId), eq(shippingRoots.id, events.rootEventId)),
    )
    .where(and(eq(shipping.tenantId, tenantId), eq(shipping.lotId, lotId)));
  const contributions = [...current(receipts, "receiving"), ...current(outputs, "transformation")];
  const originCandidate = contributions[0]?.unitOfMeasure;
  const originUom =
    originCandidate && contributions.every((row) => row.unitOfMeasure === originCandidate)
      ? (UOM_CODES_V1.find((unit) => unit === originCandidate) ?? null)
      : null;
  return {
    originUom,
    balance: computeShippingBalance({
      contributions,
      deductions: [
        ...current(inputs, "transformation"),
        ...current(shipments, "shipping", excludedShippingEventId),
      ],
    }),
  };
}

/** Caller has locked every affected lot in sorted order. */
export async function listCurrentShippingConsumers(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: readonly string[],
): Promise<CurrentConsumer[]> {
  if (!lotIds.length) return [];
  const items = schema.shippingEventItems,
    events = schema.traceabilityEvents,
    roots = schema.shippingEventRoots;
  const rows = await tx
    .select({
      lotId: items.lotId,
      eventId: events.id,
      rootId: roots.id,
      revision: events.revision,
    })
    .from(items)
    .innerJoin(events, and(eq(events.tenantId, items.tenantId), eq(events.id, items.eventId)))
    .innerJoin(
      roots,
      and(
        eq(roots.tenantId, events.tenantId),
        eq(roots.id, events.rootEventId),
        eq(roots.currentEventId, events.id),
      ),
    )
    .where(
      and(
        eq(items.tenantId, tenantId),
        inArray(items.lotId, [...new Set(lotIds)]),
        eq(events.type, "shipping"),
        eq(events.status, "finalized"),
        isNull(events.supersededByEventId),
      ),
    )
    .orderBy(asc(items.lotId), asc(roots.id), asc(events.id));
  return rows;
}

export async function listCurrentDownstreamConsumers(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: readonly string[],
): Promise<CurrentConsumer[]> {
  const transformation = await listCurrentTransformationConsumers(tx, tenantId, lotIds);
  const shipping = await listCurrentShippingConsumers(tx, tenantId, lotIds);
  return [...transformation, ...shipping].sort(
    (a, b) =>
      a.lotId.localeCompare(b.lotId) ||
      a.rootId.localeCompare(b.rootId) ||
      a.eventId.localeCompare(b.eventId),
  );
}
