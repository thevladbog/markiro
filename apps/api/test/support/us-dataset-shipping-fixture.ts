import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import type { CreateShippingDraftInput } from "@markiro/platform-contracts";
import type {
  UsDatasetContext,
  UsDatasetIntent,
  UsDatasetStageRow,
} from "../../src/modules/traceability/demo/us-dataset-contract";
import { UsDatasetReferenceSeedStore } from "../../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetReceivingSeedStore } from "../../src/modules/traceability/demo/us-dataset-receiving-seed";
import { UsDatasetTransformationSeedStore } from "../../src/modules/traceability/demo/us-dataset-transformation-seed";
import { UsDatasetCasesSeedStore } from "../../src/modules/traceability/demo/us-dataset-cases-seed";
import { makeUsDatasetReferenceIdentity } from "../../src/modules/traceability/demo/us-dataset-receiving-contract";
import {
  makeUsDatasetReceivingIdentity,
  parseUsDatasetTransformationResult,
} from "../../src/modules/traceability/demo/us-dataset-transformation-contract";
import { makeUsDatasetTransformationIdentity } from "../../src/modules/traceability/demo/us-dataset-cases-contract";
import {
  makeUsDatasetShippingInput,
  makeUsDatasetShippingPlan,
  parseUsDatasetShippingResult,
  usDatasetShippingOperationKey,
  type UsDatasetShippingInput,
  type UsDatasetShippingShipmentResult,
} from "../../src/modules/traceability/demo/us-dataset-shipping-contract";
import { parseUsDatasetReferenceResult } from "../../src/modules/traceability/demo/us-dataset-reference-contract";
import { UsShippingStore } from "../../src/modules/traceability/shipping/us-shipping-draft";
import type { createUsDatasetJournalFixture } from "./us-dataset-journal-fixture";
import { datasetTransformationStores } from "./us-dataset-transformation-fixture";

export type UsDatasetJournalFixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
export type UsDatasetShippingFixturePrepared = Readonly<{
  datasetId: string;
  input: UsDatasetShippingInput;
  intent: UsDatasetIntent;
  references: UsDatasetStageRow;
  receiving: UsDatasetStageRow;
  transformation: UsDatasetStageRow;
  cases: UsDatasetStageRow;
}>;

/** Four actual completed stores, followed by durable Shipping capture only. */
export async function prepareDatasetShippingFixture(
  f: UsDatasetJournalFixture,
  context: UsDatasetContext,
  index: number,
): Promise<UsDatasetShippingFixturePrepared> {
  await new UsDatasetReferenceSeedStore(f.db).initialize(context);
  await new UsDatasetReceivingSeedStore(f.db).initialize(context, index);
  await new UsDatasetTransformationSeedStore(f.db).initialize(context, index);
  await new UsDatasetCasesSeedStore(f.db).initialize(context, index);
  const { journal } = datasetTransformationStores(f.db);
  const header = await journal.read(context);
  if (!header) throw new Error("Missing fixture header");
  const unitKey = `chain_${String(index).padStart(4, "0")}`;
  const references = await journal.readStage(context, header.id, "references", "references");
  const receiving = await journal.readStage(context, header.id, unitKey, "receiving");
  const transformation = await journal.readStage(context, header.id, unitKey, "transformation");
  const cases = await journal.readStage(context, header.id, unitKey, "cases");
  if (!references?.receipt || !receiving?.receipt || !transformation?.receipt || !cases?.receipt)
    throw new Error("Missing fixture prerequisites");
  const origin = parseUsDatasetTransformationResult(transformation.receipt.result);
  const input = makeUsDatasetShippingInput(
    index,
    makeUsDatasetReferenceIdentity(header.id, references),
    makeUsDatasetReceivingIdentity(header.id, receiving),
    makeUsDatasetTransformationIdentity(header.id, transformation),
    origin.outputLot.id,
    origin.outputLot.productId,
  );
  const saved = await journal.captureIntent(context, header.id, {
    unitKey,
    stage: "shipping",
    operationKey: randomUUID(),
    input,
    inputDigest: canonicalExportDigest(input),
  });
  return {
    datasetId: header.id,
    input,
    intent: saved.intent,
    references,
    receiving,
    transformation,
    cases,
  };
}

/** Native commands retain their exact responses. Does not publish a Shipping receipt. */
async function executeDatasetShippingFixture(
  f: UsDatasetJournalFixture,
  context: UsDatasetContext,
  prepared: UsDatasetShippingFixturePrepared,
  drift?: "amount" | "operation key" | "request",
) {
  const stores = datasetTransformationStores(f.db),
    shipping = new UsShippingStore(f.db);
  if (!prepared.transformation.receipt || !prepared.references.receipt)
    throw new Error("Missing receipt");
  const origin = parseUsDatasetTransformationResult(prepared.transformation.receipt.result);
  const bindings = parseUsDatasetReferenceResult(prepared.references.receipt.result).bindings;
  const bound = (rows: readonly { key: string; id: string }[], key: string) => {
    const row = rows.find((entry) => entry.key === key);
    if (!row) throw new Error("Missing native binding");
    return row.id;
  };
  return f.db.transaction(
    async (tx) => {
      const shipments: UsDatasetShippingShipmentResult[] = [];
      for (const row of makeUsDatasetShippingPlan(prepared.input)) {
        const operationKey =
          drift === "operation key"
            ? randomUUID()
            : usDatasetShippingOperationKey(prepared.intent.operationKey, row.shipmentNo);
        const requestId =
          drift === "request"
            ? "synthetic-wrong-request"
            : `dataset-shipping:${prepared.intent.operationKey}:${row.shipmentNo}`;
        const documents = [];
        for (const number of row.references) {
          const definition = prepared.input.chain.documents.find(
            (entry) => entry.input.number === number,
          );
          if (!definition) throw new Error("Missing recipe document");
          const record = await stores.documents.createDocumentInTransaction(
            tx,
            context.tenantId,
            context.actorUserId,
            { ...definition.input, partyId: bound(bindings.parties, definition.partyKey) },
            requestId,
          );
          documents.push({ key: definition.key, record });
        }
        const createInput: CreateShippingDraftInput = {
          operationKey,
          draft: {
            eventDate: row.eventDate,
            shipFromLocationId: bound(bindings.locations, row.shippingLocationKey),
            recipientLocationId: bound(bindings.locations, row.recipientLocationKey),
            carrierReference: null,
            notes: "Synthetic six-month demo shipment.",
            items: [
              {
                lotId: prepared.input.outputLotId,
                quantity: drift === "amount" ? (row.shipmentNo === 1 ? "25" : "40") : row.quantity,
                unitOfMeasure: "case",
              },
            ],
            documentIds: documents.map(({ record }) => record.id),
          },
        };
        const created = await shipping.createDraftInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          createInput,
          requestId,
        );
        const readiness = await shipping.checkReadinessInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          created.id,
          { expectedDraftVersion: 1 },
        );
        if (readiness.state !== "complete") throw new Error("Native Shipping readiness incomplete");
        const finalizeInput = {
          operationKey,
          expectedDraftVersion: 1,
          expectedInputDigest: readiness.inputDigest,
        };
        const finalized = await shipping.finalizeInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          created.id,
          finalizeInput,
          requestId,
        );
        shipments.push({
          shipmentNo: row.shipmentNo,
          operationKey,
          requestId,
          documents,
          createInput,
          finalizeInput,
          created,
          finalized,
        });
      }
      const outputLotAfter = await stores.lots.getLotInTransaction(
        tx,
        context.tenantId,
        context.actorUserId,
        prepared.input.outputLotId,
      );
      return { input: prepared.input, originLot: origin.outputLot, outputLotAfter, shipments };
    },
    { isolationLevel: "read committed" },
  );
}

export async function applyDatasetShippingFixture(
  f: UsDatasetJournalFixture,
  context: UsDatasetContext,
  prepared: UsDatasetShippingFixturePrepared,
) {
  return parseUsDatasetShippingResult(await executeDatasetShippingFixture(f, context, prepared));
}

/** Native commands deliberately disagree with captured intent; no forged business rows/receipts. */
export async function applyDatasetShippingDriftFixture(
  f: UsDatasetJournalFixture,
  context: UsDatasetContext,
  prepared: UsDatasetShippingFixturePrepared,
  drift: "amount" | "operation key" | "request",
) {
  return executeDatasetShippingFixture(f, context, prepared, drift);
}
