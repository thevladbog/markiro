import { schema } from "@markiro/db";
import {
  createTransformationDraftSchema,
  finalizeTransformationSchema,
  type TraceabilityLot,
} from "@markiro/platform-contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import type { UsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import {
  US_DATASET_TRANSFORMATION_METADATA,
  type UsDatasetTransformationEvidence,
} from "./us-dataset-transformation-content.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";
import type { UsSixMonthChain } from "./us-six-month-chains.js";

/** Supplied transaction only: no retry, prerequisite installation or nested transaction. */
export async function applyUsDatasetTransformationContent(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  operationKey: string,
  chain: UsSixMonthChain,
  bindings: UsDatasetReferenceResult["bindings"],
  inputLots: readonly TraceabilityLot[],
  stores: UsDatasetTransformationStores,
  fail: () => Error,
): Promise<Omit<UsDatasetTransformationEvidence, "input">> {
  const bound = (entries: readonly { key: string; id: string }[], key: string) => {
    const matches = entries.filter((entry) => entry.key === key);
    if (matches.length !== 1 || !matches[0]) throw fail();
    return matches[0].id;
  };
  const { tenantId, actorUserId } = context;
  const operations = schema.transformationOperations;
  if (
    (
      await tx
        .select({ id: operations.operationKey })
        .from(operations)
        .where(
          and(
            eq(operations.tenantId, tenantId),
            eq(operations.operationKey, operationKey),
            inArray(operations.command, ["transformation.create", "transformation.finalize"]),
          ),
        )
        .limit(1)
    ).length
  )
    throw fail();
  const definitions = chain.transformation.references.map((number) => {
    const matches = chain.documents.filter((d) => d.input.number === number);
    if (matches.length !== 1 || !matches[0]) throw fail();
    return matches[0];
  });
  const docs = schema.referenceDocuments;
  for (const definition of definitions)
    if (
      (
        await tx
          .select({ id: docs.id })
          .from(docs)
          .where(
            and(
              eq(docs.tenantId, tenantId),
              eq(docs.type, definition.input.type),
              eq(docs.number, definition.input.number),
              eq(docs.partyId, bound(bindings.parties, definition.partyKey)),
            ),
          )
          .limit(1)
      ).length
    )
      throw fail();
  const processorId = bound(bindings.locations, chain.transformation.locationKey);
  const lots = schema.traceabilityLots;
  if (
    (
      await tx
        .select({ id: lots.id })
        .from(lots)
        .where(
          and(
            eq(lots.tenantId, tenantId),
            eq(lots.tlc, chain.transformation.output.tlc),
            eq(lots.sourceLocationId, processorId),
          ),
        )
        .limit(1)
    ).length
  )
    throw fail();
  const documents = [];
  for (const definition of definitions)
    documents.push({
      key: definition.key,
      record: await stores.documents.createDocumentInTransaction(
        tx,
        tenantId,
        actorUserId,
        { ...definition.input, partyId: bound(bindings.parties, definition.partyKey) },
        operationKey,
      ),
    });
  const createInput = createTransformationDraftSchema.parse({
    operationKey,
    draft: {
      eventDate: chain.transformation.eventDate,
      processorLocationId: processorId,
      ...US_DATASET_TRANSFORMATION_METADATA,
      documentIds: documents.map((d) => d.record.id),
      inputs: chain.transformation.inputs.map((line, i) => ({
        kind: "ftl_lot",
        lotId: inputLots[i]?.id,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
      })),
      outputs: [
        {
          productId: bound(bindings.products, chain.transformation.output.productKey),
          tlc: chain.transformation.output.tlc,
          quantity: chain.transformation.output.quantity,
          unitOfMeasure: chain.transformation.output.unitOfMeasure,
        },
      ],
    },
  });
  const created = await stores.transformation.createDraftInTransaction(
    tx,
    tenantId,
    actorUserId,
    createInput,
    operationKey,
  );
  const ready = await stores.transformation.checkReadinessInTransaction(
    tx,
    tenantId,
    actorUserId,
    created.id,
    { expectedDraftVersion: created.draftVersion },
  );
  if (ready.state !== "complete") throw fail();
  const finalizeInput = finalizeTransformationSchema.parse({
    operationKey,
    expectedDraftVersion: created.draftVersion,
    expectedInputDigest: ready.inputDigest,
  });
  const finalized = await stores.transformation.finalizeInTransaction(
    tx,
    tenantId,
    actorUserId,
    created.id,
    finalizeInput,
    operationKey,
  );
  const output = finalized.snapshot.outputs[0];
  if (!output) throw fail();
  const outputLot = await stores.lots.getLotInTransaction(tx, tenantId, actorUserId, output.lotId);

  return {
    documents,
    createInput,
    finalizeInput,
    created,
    finalized,
    outputLot,
    inputLots: inputLots.map((lot, i) => ({ lineNo: i + 1, lotId: lot.id })),
  };
}
