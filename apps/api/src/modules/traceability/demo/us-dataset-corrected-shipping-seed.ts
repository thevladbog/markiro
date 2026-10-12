import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
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
import {
  usDatasetShippingOperationKey,
  type UsDatasetShippingShipmentResult,
} from "./us-dataset-shipping-contract.js";
import type { UsDatasetShippingStores } from "./us-dataset-shipping-prepare.js";
import {
  authorizeUsDatasetCorrectedShipping,
  prepareUsDatasetCorrectedShipping,
  readUsDatasetCorrectedShippingInput,
} from "./us-dataset-corrected-shipping-prepare.js";
import {
  makeUsDatasetCorrectedShippingPlan,
  parseUsDatasetCorrectedShippingInput,
} from "./us-dataset-corrected-shipping-contract.js";
import {
  datasetCorrectedShippingError,
  parseUsDatasetCorrectedShippingResult,
  usDatasetCorrectedShippingRecordIds,
  type UsDatasetCorrectedShippingResult,
} from "./us-dataset-corrected-shipping-result.js";
import { verifyUsDatasetCorrectedShipping } from "./us-dataset-corrected-shipping-verify.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

export class UsDatasetCorrectedShippingSeedStore {
  private readonly stores: UsDatasetShippingStores;
  constructor(private readonly db: Db) {
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
  initialize(context: UsDatasetContext): Promise<UsDatasetCorrectedShippingResult> {
    return this.execute(context, true);
  }
  verify(context: UsDatasetContext): Promise<UsDatasetCorrectedShippingResult> {
    return this.execute(context, false);
  }
  private async execute(
    context: UsDatasetContext,
    capture: boolean,
  ): Promise<UsDatasetCorrectedShippingResult> {
    const unitKey = "correction_0001";
    try {
      const { journal } = this.stores;
      const datasetId = await this.db.transaction((tx) =>
        authorizeUsDatasetCorrectedShipping(tx, context, this.stores),
      );
      const header = { id: datasetId };
      const input = await readUsDatasetCorrectedShippingInput(journal, context, header.id);
      const checkedStage = (stage: UsDatasetStageRow | null) => {
        if (
          stage &&
          (stage.unitKey !== unitKey ||
            stage.stage !== "shipping" ||
            canonicalExportDigest(parseUsDatasetCorrectedShippingInput(stage.intent.input)) !==
              canonicalExportDigest(input))
        )
          throw datasetCorrectedShippingError("us_dataset_corrected_shipping_conflict");
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
        throw datasetCorrectedShippingError(
          "us_dataset_corrected_shipping_prerequisite_incomplete",
        );
      let applied = false;
      const completed = await journal.runAtomicStage(
        context,
        header.id,
        stage.revision,
        stage.intent,
        {
          apply: async (tx, checked, intent) => {
            if (!capture)
              throw datasetCorrectedShippingError(
                "us_dataset_corrected_shipping_prerequisite_incomplete",
              );
            const prepared = await prepareUsDatasetCorrectedShipping(
              tx,
              checked,
              intent,
              { mode: "application" },
              this.stores,
            );
            const bindings = prepared.bindings;
            const bound = (rows: readonly { key: string; id: string }[], key: string) => {
              const row = rows.find((entry) => entry.key === key);
              if (!row)
                throw datasetCorrectedShippingError("us_dataset_corrected_shipping_conflict");
              return row.id;
            };
            const shipments: UsDatasetShippingShipmentResult[] = [];
            // Fresh document/root rows are private inserts. All public receipt-owned
            // references and documents were retained before Cases support locks.
            for (const row of makeUsDatasetCorrectedShippingPlan(prepared.input)) {
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
                  throw datasetCorrectedShippingError("us_dataset_corrected_shipping_conflict");
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
                      lotId: prepared.input.casesInput.outputLotId,
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
                throw datasetCorrectedShippingError("us_dataset_corrected_shipping_conflict");
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
              prepared.input.casesInput.outputLotId,
            );
            const result = parseUsDatasetCorrectedShippingResult({
              input: prepared.input,
              originLot: prepared.origin.outputLot,
              outputLotAfter,
              shipments,
            });
            applied = true;
            return {
              result,
              recordIds: usDatasetCorrectedShippingRecordIds(result),
              resultDigest: canonicalExportDigest(result),
            };
          },
          verify: (tx, checked, intent, receipt) =>
            verifyUsDatasetCorrectedShipping(
              tx,
              checked,
              intent,
              receipt,
              this.stores,
              applied ? "fresh" : "replay",
            ),
        },
      );
      if (!completed.receipt)
        throw datasetCorrectedShippingError(
          "us_dataset_corrected_shipping_prerequisite_incomplete",
        );
      return parseUsDatasetCorrectedShippingResult(completed.receipt.result);
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
