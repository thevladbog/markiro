import { schema } from "@markiro/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import type { UsDatasetCorrectedTransformationResult } from "./us-dataset-corrected-transformation-result.js";
import type { UsDatasetCorrectedShippingResult } from "./us-dataset-corrected-shipping-result.js";
import { datasetCorrectedShippingError } from "./us-dataset-corrected-shipping-result.js";

/** All receipt-owned roots/revisions precede the sorted union of origin/output lots. */
export async function lockUsDatasetCorrectedShipping(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  origin: UsDatasetCorrectedTransformationResult,
  known: UsDatasetCorrectedShippingResult | null,
): Promise<void> {
  const fail = () => datasetCorrectedShippingError("us_dataset_corrected_shipping_mismatch");
  for (const [table, id, type] of [
    [schema.receivingEventRoots, origin.input.receivingOrigin.rootId, "receiving"],
    [schema.transformationEventRoots, origin.created.id, "transformation"],
    ...(known?.shipments.map(
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
    if (!revisions.some((row) => row.id === id) || revisions.some((row) => row.type !== type))
      throw fail();
  }
  const ids = [
    ...new Set([...origin.inputLots.map(({ lotId }) => lotId), origin.outputLot.id]),
  ].sort();
  const lots = schema.traceabilityLots;
  const owned = await tx
    .select({ id: lots.id })
    .from(lots)
    .where(and(eq(lots.tenantId, context.tenantId), inArray(lots.id, ids)))
    .orderBy(asc(lots.id))
    .for("update");
  if (owned.length !== ids.length || owned.some((row, index) => row.id !== ids[index]))
    throw fail();
}
