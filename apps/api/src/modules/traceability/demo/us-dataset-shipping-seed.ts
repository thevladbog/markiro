import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";

import { canonicalExportDigest, canonicalExportJson } from "./us-demo-canonical.js";
import type { CreateShippingDraftInput } from "@markiro/platform-contracts";
import { UsCatalogStore } from "../catalog/us-catalog-store.js";
import { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import { UsLotStore } from "../lots/us-lot-store.js";
import { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import { UsProductProfileStore } from "../products/us-product-profile-store.js";
import { UsReceivingStore } from "../receiving/us-receiving-store.js";
import { UsTransformationStore } from "../transformation/us-transformation-store.js";
import { UsShippingStore } from "../shipping/us-shipping-draft.js";
import type { UsDatasetContext, UsDatasetStageRow } from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { makeUsDatasetTransformationIdentity } from "./us-dataset-cases-contract.js";
import { makeUsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import {
  makeUsDatasetReceivingIdentity,
  parseUsDatasetTransformationResult,
} from "./us-dataset-transformation-contract.js";
import {
  datasetShippingError,
  makeUsDatasetShippingInput,
  makeUsDatasetShippingPlan,
  parseUsDatasetShippingInput,
  parseUsDatasetShippingResult,
  usDatasetShippingOperationKey,
  usDatasetShippingRecordIds,
  type UsDatasetShippingResult,
  type UsDatasetShippingShipmentResult,
} from "./us-dataset-shipping-contract.js";
import {
  prepareUsDatasetShipping,
  type UsDatasetShippingStores,
} from "./us-dataset-shipping-prepare.js";
import { verifyUsDatasetShippingFinal } from "./us-dataset-native-final-verify.js";
import { makeUsSixMonthRegularChain } from "./us-six-month-chains.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import type { UsDatasetShippingProjection } from "./us-dataset-shipping-projection.js";

export class UsDatasetShippingSeedStore {
  private readonly stores: UsDatasetShippingStores;
  constructor(db: Db) {
    this.stores = {
      journal: new UsDatasetJournalStore(db, usSixMonthDefinition),
      master: new UsMasterDataStore(db),
      catalog: new UsCatalogStore(db),
      profiles: new UsProductProfileStore(db),
      documents: new UsReferenceDocumentStore(db),
      lots: new UsLotStore(db),
      receiving: new UsReceivingStore(db),
      transformation: new UsTransformationStore(db),
      shipping: new UsShippingStore(db),
    };
  }
  async initialize(context: UsDatasetContext, index: number): Promise<UsDatasetShippingResult> {
    return (await this.execute(context, index, true)).shipping;
  }
  initializeTerminalProjection(
    context: UsDatasetContext,
    index: number,
  ): Promise<UsDatasetShippingProjection> {
    return this.execute(context, index, true);
  }
  async verify(context: UsDatasetContext, index: number): Promise<UsDatasetShippingResult> {
    return (await this.execute(context, index, false)).shipping;
  }
  verifyTerminalProjection(
    context: UsDatasetContext,
    index: number,
  ): Promise<UsDatasetShippingProjection> {
    return this.execute(context, index, false);
  }
  private async execute(
    context: UsDatasetContext,
    index: number,
    capture: boolean,
  ): Promise<UsDatasetShippingProjection> {
    let unitKey = "unknown";
    try {
      const { journal } = this.stores;
      const header = await journal.read(context);
      if (!header)
        throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
      let chain;
      try {
        chain = makeUsSixMonthRegularChain(index);
        unitKey = chain.unitKey;
      } catch (cause) {
        throw datasetShippingError("us_dataset_shipping_input_invalid", unitKey, cause);
      }
      const [references, receiving, transformation, cases] = await journal.readStages(
        context,
        header.id,
        [
          { unitKey: "references", stage: "references" },
          { unitKey, stage: "receiving" },
          { unitKey, stage: "transformation" },
          { unitKey, stage: "cases" },
        ],
      );
      if (
        !references?.receipt ||
        !receiving?.receipt ||
        !transformation?.receipt ||
        !cases?.receipt
      )
        throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
      const origin = parseUsDatasetTransformationResult(transformation.receipt.result);
      const input = makeUsDatasetShippingInput(
        index,
        makeUsDatasetReferenceIdentity(header.id, references),
        makeUsDatasetReceivingIdentity(header.id, receiving),
        makeUsDatasetTransformationIdentity(header.id, transformation),
        origin.outputLot.id,
        origin.outputLot.productId,
      );
      const checkedStage = (stage: UsDatasetStageRow | null) => {
        if (
          stage &&
          (stage.unitKey !== unitKey ||
            stage.stage !== "shipping" ||
            canonicalExportJson(parseUsDatasetShippingInput(stage.intent.input)) !==
              canonicalExportJson(input))
        )
          throw datasetShippingError("us_dataset_shipping_dependency_conflict", unitKey);
        return stage;
      };
      let stage = checkedStage(await journal.readStage(context, header.id, unitKey, "shipping"));
      if (!stage && capture) {
        try {
          stage = checkedStage(
            await journal.captureIntent(context, header.id, {
              unitKey,
              stage: "shipping",
              operationKey: randomUUID(),
              input,
              inputDigest: canonicalExportDigest(input),
            }),
          );
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "us_dataset_intent_conflict")
            throw error;
          stage = checkedStage(await journal.readStage(context, header.id, unitKey, "shipping"));
          if (!stage) throw error;
        }
      }
      if (!stage || (!capture && !stage.receipt))
        throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
      let applied = false;
      // Invocation-local only: a callback result cannot escape before COMMIT.
      let projection: UsDatasetShippingProjection | undefined;
      const completed = await journal.runAtomicStage(
        context,
        header.id,
        stage.revision,
        stage.intent,
        {
          apply: async (tx, checked, intent) => {
            if (!capture)
              throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
            const prepared = await prepareUsDatasetShipping(
              tx,
              checked,
              header.id,
              unitKey,
              "application",
              this.stores,
            );
            const bindings = parseUsDatasetReferenceResult(
              prepared.references.receipt?.result,
            ).bindings;
            const bound = (rows: readonly { key: string; id: string }[], key: string) => {
              const row = rows.find((entry) => entry.key === key);
              if (!row) throw datasetShippingError("us_dataset_shipping_conflict", unitKey);
              return row.id;
            };
            const shipments: UsDatasetShippingShipmentResult[] = [];
            // Fresh document/root rows are private inserts. All public receipt-owned
            // references and documents were retained before Cases support locks.
            for (const row of makeUsDatasetShippingPlan(prepared.input)) {
              const operationKey = usDatasetShippingOperationKey(
                intent.operationKey,
                row.shipmentNo,
              );
              const requestId = `dataset-shipping:${intent.operationKey}:${row.shipmentNo}`;
              const documents = [];
              for (const number of row.references) {
                const definition = prepared.input.chain.documents.find(
                  (entry) => entry.input.number === number,
                );
                if (!definition)
                  throw datasetShippingError("us_dataset_shipping_conflict", unitKey);
                const record = await this.stores.documents.createDocumentInTransaction(
                  tx,
                  checked.tenantId,
                  checked.actorUserId,
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
                      quantity: row.quantity,
                      unitOfMeasure: row.unitOfMeasure,
                    },
                  ],
                  documentIds: documents.map(({ record }) => record.id),
                },
              };
              const created = await this.stores.shipping.createDraftInTransaction(
                tx,
                checked.tenantId,
                checked.actorUserId,
                createInput,
                requestId,
              );
              const ready = await this.stores.shipping.checkReadinessInTransaction(
                tx,
                checked.tenantId,
                checked.actorUserId,
                created.id,
                { expectedDraftVersion: created.draftVersion },
              );
              if (ready.state !== "complete")
                throw datasetShippingError("us_dataset_shipping_conflict", unitKey);
              const finalizeInput = {
                operationKey,
                expectedDraftVersion: created.draftVersion,
                expectedInputDigest: ready.inputDigest,
              };
              const finalized = await this.stores.shipping.finalizeInTransaction(
                tx,
                checked.tenantId,
                checked.actorUserId,
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
            const outputLotAfter = await this.stores.lots.getLotInTransaction(
              tx,
              checked.tenantId,
              checked.actorUserId,
              prepared.input.outputLotId,
            );
            const result = parseUsDatasetShippingResult({
              input: prepared.input,
              originLot: parseUsDatasetTransformationResult(prepared.transformation.receipt?.result)
                .outputLot,
              outputLotAfter,
              shipments,
            });
            applied = true;
            return {
              result,
              recordIds: usDatasetShippingRecordIds(result),
              resultDigest: canonicalExportDigest(result),
            };
          },
          verify: async (tx, checked, intent, receipt) => {
            projection = await verifyUsDatasetShippingFinal(
              tx,
              checked,
              intent,
              receipt,
              this.stores,
              applied ? "fresh" : "replay",
            );
          },
        },
      );
      if (!completed.receipt)
        throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
      if (!projection) throw datasetShippingError("us_dataset_shipping_mismatch", unitKey);
      return projection;
    } catch (error) {
      if (error instanceof Error && Object.isExtensible(error)) {
        try {
          Object.defineProperties(error, {
            unitKey: { value: unitKey, enumerable: true, configurable: true, writable: true },
            stage: { value: "shipping", enumerable: true, configurable: true, writable: true },
          });
        } catch {
          /* Keep original driver/domain identity if annotations cannot be changed. */
        }
      }
      throw error;
    }
  }
}
