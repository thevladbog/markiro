import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import {
  createTransformationDraftSchema,
  finalizeTransformationSchema,
} from "@markiro/platform-contracts";
import type {
  UsDatasetContext,
  UsDatasetIntent,
} from "../../src/modules/traceability/demo/us-dataset-contract";
import type { UsDemoTransaction } from "../../src/modules/traceability/demo/us-demo-atomic-stage-contract";
import { UsDatasetJournalStore } from "../../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetReferenceSeedStore } from "../../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetReceivingSeedStore } from "../../src/modules/traceability/demo/us-dataset-receiving-seed";
import { makeUsDatasetReferenceIdentity } from "../../src/modules/traceability/demo/us-dataset-receiving-contract";
import {
  makeUsDatasetReceivingIdentity,
  makeUsDatasetTransformationInput,
  parseUsDatasetTransformationResult,
  usDatasetTransformationRecordIds,
  US_DATASET_TRANSFORMATION_METADATA,
} from "../../src/modules/traceability/demo/us-dataset-transformation-contract";
import { usSixMonthDefinition } from "../../src/modules/traceability/demo/us-six-month-definition";
import { UsCatalogStore } from "../../src/modules/traceability/catalog/us-catalog-store";
import { UsReferenceDocumentStore } from "../../src/modules/traceability/documents/us-reference-document-store";
import { UsLotStore } from "../../src/modules/traceability/lots/us-lot-store";
import { UsMasterDataStore } from "../../src/modules/traceability/master-data/us-master-data-store";
import { UsProductProfileStore } from "../../src/modules/traceability/products/us-product-profile-store";
import { UsReceivingStore } from "../../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../../src/modules/traceability/transformation/us-transformation-store";

export function datasetTransformationStores(db: Db) {
  return {
    journal: new UsDatasetJournalStore(db, usSixMonthDefinition),
    master: new UsMasterDataStore(db),
    catalog: new UsCatalogStore(db),
    profiles: new UsProductProfileStore(db),
    documents: new UsReferenceDocumentStore(db),
    lots: new UsLotStore(db),
    receiving: new UsReceivingStore(db),
    transformation: new UsTransformationStore(db),
  };
}
function bound(entries: readonly { key: string; id: string }[], key: string): string {
  const found = entries.find((e) => e.key === key);
  if (!found) throw new Error("Missing native fixture binding");
  return found.id;
}

/** Real installed prerequisites, then local native composition; no seed SQL or executor under test. */
export async function prepareDatasetTransformation(db: Db, context: UsDatasetContext, index = 259) {
  const stores = datasetTransformationStores(db);
  const references = await new UsDatasetReferenceSeedStore(db).initialize(context);
  const receiving = await new UsDatasetReceivingSeedStore(db).initialize(context, index);
  const header = await stores.journal.read(context);
  if (!header) throw new Error("Missing fixture dataset");
  const referenceStage = await stores.journal.readStage(
    context,
    header.id,
    "references",
    "references",
  );
  const receivingStage = await stores.journal.readStage(
    context,
    header.id,
    receiving.input.chain.unitKey,
    "receiving",
  );
  if (!referenceStage?.receipt || !receivingStage?.receipt)
    throw new Error("Missing fixture prerequisites");
  const input = makeUsDatasetTransformationInput(
    index,
    makeUsDatasetReferenceIdentity(header.id, referenceStage),
    makeUsDatasetReceivingIdentity(header.id, receivingStage),
  );
  const operationKey = randomUUID();
  const intent: UsDatasetIntent = {
    unitKey: input.chain.unitKey,
    stage: "transformation",
    operationKey,
    input,
    inputDigest: canonicalExportDigest(input),
  };
  async function apply(tx: UsDemoTransaction) {
    const documents = [];
    for (const number of input.chain.transformation.references) {
      const definition = input.chain.documents.find((d) => d.input.number === number);
      if (!definition) throw new Error("Missing fixture document");
      documents.push({
        key: definition.key,
        record: await stores.documents.createDocumentInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          { ...definition.input, partyId: bound(references.bindings.parties, definition.partyKey) },
          operationKey,
        ),
      });
    }
    const createInput = createTransformationDraftSchema.parse({
      operationKey,
      draft: {
        eventDate: input.chain.transformation.eventDate,
        processorLocationId: bound(
          references.bindings.locations,
          input.chain.transformation.locationKey,
        ),
        ...US_DATASET_TRANSFORMATION_METADATA,
        documentIds: documents.map((d) => d.record.id),
        inputs: input.chain.transformation.inputs.map((line, i) => ({
          kind: "ftl_lot",
          lotId: receiving.lots[i]?.id,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
        })),
        outputs: [
          {
            productId: bound(
              references.bindings.products,
              input.chain.transformation.output.productKey,
            ),
            tlc: input.chain.transformation.output.tlc,
            quantity: input.chain.transformation.output.quantity,
            unitOfMeasure: input.chain.transformation.output.unitOfMeasure,
          },
        ],
      },
    });
    const created = await stores.transformation.createDraftInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      createInput,
      operationKey,
    );
    const ready = await stores.transformation.checkReadinessInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.id,
      { expectedDraftVersion: created.draftVersion },
    );
    if (ready.state !== "complete") throw new Error("Native fixture transformation incomplete");
    const finalizeInput = finalizeTransformationSchema.parse({
      operationKey,
      expectedDraftVersion: created.draftVersion,
      expectedInputDigest: ready.inputDigest,
    });
    const finalized = await stores.transformation.finalizeInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.id,
      finalizeInput,
      operationKey,
    );
    const output = finalized.snapshot.outputs[0];
    if (!output) throw new Error("Missing native output");
    const outputLot = await stores.lots.getLotInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      output.lotId,
    );
    const result = parseUsDatasetTransformationResult({
      input,
      documents,
      createInput,
      finalizeInput,
      created,
      finalized,
      outputLot,
      inputLots: receiving.lots.map((lot, i) => ({ lineNo: i + 1, lotId: lot.id })),
    });
    return {
      result,
      resultDigest: canonicalExportDigest(result),
      recordIds: usDatasetTransformationRecordIds(result),
    };
  }
  return {
    stores,
    header,
    references,
    referenceStage,
    receiving,
    receivingStage,
    input,
    intent,
    apply,
  };
}

export async function composeDatasetTransformation(db: Db, context: UsDatasetContext, index = 259) {
  const prepared = await prepareDatasetTransformation(db, context, index);
  const receipt = await db.transaction(prepared.apply);
  return { ...prepared, receipt, result: receipt.result };
}
