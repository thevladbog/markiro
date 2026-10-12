import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import {
  parseUsDatasetReceivingResult,
  type UsDatasetReceivingResult,
} from "./us-dataset-receiving-contract.js";
import {
  datasetTransformationError,
  parseUsDatasetTransformationResult,
  type UsDatasetTransformationResult,
} from "./us-dataset-transformation-contract.js";

export type UsDatasetTransformationLockTarget = Readonly<{
  receiving: UsDatasetReceivingResult;
  transformation: UsDatasetTransformationResult | null;
}>;

/** Only receipt-owned identities; never discover another root from support/genealogy. */
export async function lockUsDatasetTransformation(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  target: UsDatasetTransformationLockTarget,
): Promise<void> {
  const receiving = parseUsDatasetReceivingResult(target.receiving);
  const transformation =
    target.transformation === null
      ? null
      : parseUsDatasetTransformationResult(target.transformation);
  const fail = () =>
    datasetTransformationError("us_dataset_transformation_mismatch", receiving.input.chain.unitKey);
  if (
    transformation &&
    (canonicalExportDigest(transformation.input.chain) !==
      canonicalExportDigest(receiving.input.chain) ||
      canonicalExportDigest(transformation.input.references) !==
        canonicalExportDigest(receiving.input.references) ||
      transformation.inputLots.some((line, i) => line.lotId !== receiving.lots[i]?.id))
  )
    throw fail();
  await lockUsDatasetTransformationRows(
    tx,
    context,
    {
      receivingRootId: receiving.created.eventId,
      transformationRootId: transformation?.created.id ?? null,
      lotIds: [
        ...receiving.lots.map((lot) => lot.id),
        ...(transformation ? [transformation.outputLot.id] : []),
      ],
    },
    fail,
  );
}

/** Internal concrete owned roots and sorted union; callers arbitrate operations first. */
export async function lockUsDatasetTransformationRows(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  target: Readonly<{
    receivingRootId: string;
    transformationRootId: string | null;
    lotIds: readonly string[];
  }>,
  fail: () => Error,
): Promise<void> {
  // Public Receiving and Transformation lifecycle writers hold their root before
  // revisions and affected lots. Both roots MUST precede the UNION of lot locks.
  for (const [table, id, type] of [
    [schema.receivingEventRoots, target.receivingRootId, "receiving"],
    ...(target.transformationRootId
      ? [[schema.transformationEventRoots, target.transformationRootId, "transformation"] as const]
      : []),
  ] as const) {
    const roots = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, context.tenantId), eq(table.id, id)))
      .for("update");
    if (roots.length !== 1) throw fail();
    const events = schema.traceabilityEvents;
    const revisions = await tx
      .select()
      .from(events)
      .where(and(eq(events.tenantId, context.tenantId), eq(events.rootEventId, id)))
      .orderBy(asc(events.id))
      .for("update");
    if (!revisions.some((row) => row.id === id) || revisions.some((row) => row.type !== type))
      throw fail();
  }
  const lotIds = [...new Set(target.lotIds)].sort();
  const lots = schema.traceabilityLots;
  const owned = await tx
    .select({ id: lots.id })
    .from(lots)
    .where(and(eq(lots.tenantId, context.tenantId), inArray(lots.id, lotIds)))
    .orderBy(asc(lots.id))
    .for("update");
  if (canonicalExportDigest(owned.map((row) => row.id)) !== canonicalExportDigest(lotIds))
    throw fail();
}
