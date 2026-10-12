import { schema } from "@markiro/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import type { UsDatasetReceivingResult } from "./us-dataset-receiving-contract.js";
import type { UsDatasetTransformationResult } from "./us-dataset-transformation-contract.js";
import {
  datasetShippingError,
  type UsDatasetShippingResult,
} from "./us-dataset-shipping-contract.js";

/** Public lifecycle writers take root/revisions before lots. Native amend inserts
 * items whose lot FK takes KEY SHARE; pending void can touch only root/revisions.
 * Never discover an unknown Shipping root after acquiring the union of lots. */
export async function lockUsDatasetShipping(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  receiving: UsDatasetReceivingResult,
  transformation: UsDatasetTransformationResult,
  shipping: UsDatasetShippingResult | null,
): Promise<void> {
  const fail = () =>
    datasetShippingError("us_dataset_shipping_mismatch", receiving.input.chain.unitKey);
  for (const [table, id, type] of [
    [schema.receivingEventRoots, receiving.created.eventId, "receiving"],
    [schema.transformationEventRoots, transformation.created.id, "transformation"],
    ...(shipping?.shipments.map(
      (row) => [schema.shippingEventRoots, row.created.id, "shipping"] as const,
    ) ?? []),
  ] as const) {
    const roots = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, context.tenantId), eq(table.id, id)))
      .for("update");
    if (roots.length !== 1) throw fail();
    const events = schema.traceabilityEvents;
    const revisions = await tx
      .select({ id: events.id, type: events.type })
      .from(events)
      .where(and(eq(events.tenantId, context.tenantId), eq(events.rootEventId, id)))
      .orderBy(asc(events.id))
      .for("update");
    if (revisions.length !== 1 || revisions[0]?.id !== id || revisions[0]?.type !== type)
      throw fail();
  }
  const lotIds = [
    ...new Set([...receiving.lots.map((lot) => lot.id), transformation.outputLot.id]),
  ].sort();
  const lots = schema.traceabilityLots;
  const rows = await tx
    .select({ id: lots.id })
    .from(lots)
    .where(and(eq(lots.tenantId, context.tenantId), inArray(lots.id, lotIds)))
    .orderBy(asc(lots.id))
    .for("update");
  if (rows.length !== lotIds.length || rows.some((row, index) => row.id !== lotIds[index]))
    throw fail();
}
