import { verifyUsDatasetCorrectedTransformationFinal } from "./us-dataset-native-final-verify.js";
import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { UsCatalogStore } from "../catalog/us-catalog-store.js";
import { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import { UsLotStore } from "../lots/us-lot-store.js";
import { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import { UsProductProfileStore } from "../products/us-product-profile-store.js";
import { UsReceivingStore } from "../receiving/us-receiving-store.js";
import { UsTransformationStore } from "../transformation/us-transformation-store.js";
import type {
  UsDatasetContext,
  UsDatasetIntent,
  UsDatasetStageRow,
} from "./us-dataset-contract.js";
import { datasetCorrectedTransformationError } from "./us-dataset-corrected-transformation-contract.js";
import {
  prepareUsDatasetCorrectedTransformation,
  readUsDatasetCorrectedTransformationInput,
} from "./us-dataset-corrected-transformation-prepare.js";
import {
  parseUsDatasetCorrectedTransformationResult,
  usDatasetCorrectedTransformationRecordIds,
  type UsDatasetCorrectedTransformationResult,
} from "./us-dataset-corrected-transformation-result.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { applyUsDatasetTransformationContent } from "./us-dataset-transformation-apply-content.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

/** Fixed internal corrected stage; installed completed prerequisites are required. */
export class UsDatasetCorrectedTransformationSeedStore {
  private readonly stores: UsDatasetTransformationStores;
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
    };
  }
  initialize(context: UsDatasetContext): Promise<UsDatasetCorrectedTransformationResult> {
    return this.execute(context, true);
  }
  verify(context: UsDatasetContext): Promise<UsDatasetCorrectedTransformationResult> {
    return this.execute(context, false);
  }
  private async execute(
    context: UsDatasetContext,
    capture: boolean,
  ): Promise<UsDatasetCorrectedTransformationResult> {
    const incomplete = () =>
      datasetCorrectedTransformationError(
        "us_dataset_corrected_transformation_prerequisite_incomplete",
      );
    try {
      const journal = this.stores.journal;
      const header = await journal.read(context);
      if (!header) throw incomplete();
      const input = await readUsDatasetCorrectedTransformationInput(journal, context, header.id);
      const checked = (stage: UsDatasetStageRow | null) => {
        if (
          stage &&
          (stage.unitKey !== "correction_0001" ||
            stage.stage !== "transformation" ||
            canonicalExportDigest(stage.intent.input) !== canonicalExportDigest(input))
        )
          throw datasetCorrectedTransformationError(
            "us_dataset_corrected_transformation_dependency_conflict",
          );
        return stage;
      };
      let stage = checked(
        await journal.readStage(context, header.id, "correction_0001", "transformation"),
      );
      if (!stage && capture) {
        const intent: UsDatasetIntent = {
          unitKey: "correction_0001",
          stage: "transformation",
          operationKey: randomUUID(),
          input,
          inputDigest: canonicalExportDigest(input),
        };
        try {
          stage = checked(await journal.captureIntent(context, header.id, intent));
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "us_dataset_intent_conflict")
            throw error;
          stage = checked(
            await journal.readStage(context, header.id, "correction_0001", "transformation"),
          );
          if (!stage) throw error;
        }
      }
      if (!stage || (!capture && !stage.receipt)) throw incomplete();
      let applied = false;
      const completed = await journal.runAtomicStage(
        context,
        header.id,
        stage.revision,
        stage.intent,
        {
          apply: async (tx, checkedContext, intent) => {
            if (!capture) throw incomplete();
            const prepared = await prepareUsDatasetCorrectedTransformation(
              tx,
              checkedContext,
              intent,
              this.stores,
              null,
            );
            const evidence = await applyUsDatasetTransformationContent(
              tx,
              checkedContext,
              intent.operationKey,
              prepared.input.chain,
              prepared.bindings,
              prepared.inputLots,
              this.stores,
              () =>
                datasetCorrectedTransformationError("us_dataset_corrected_transformation_conflict"),
            );
            const result = parseUsDatasetCorrectedTransformationResult({
              input: prepared.input,
              ...evidence,
            });
            applied = true;
            return {
              result,
              resultDigest: canonicalExportDigest(result),
              recordIds: usDatasetCorrectedTransformationRecordIds(result),
            };
          },
          verify: (tx, checkedContext, intent, receipt) =>
            verifyUsDatasetCorrectedTransformationFinal(
              tx,
              checkedContext,
              intent,
              receipt,
              this.stores,
              applied ? "fresh" : "replay",
            ),
        },
      );
      if (!completed.receipt) throw incomplete();
      return parseUsDatasetCorrectedTransformationResult(completed.receipt.result);
    } catch (error) {
      if (error instanceof Error && Object.isExtensible(error)) {
        try {
          Object.defineProperties(error, {
            unitKey: {
              value: "correction_0001",
              enumerable: true,
              configurable: true,
              writable: true,
            },
            stage: {
              value: "transformation",
              enumerable: true,
              configurable: true,
              writable: true,
            },
          });
        } catch {
          /* Preserve non-configurable primary errors. */
        }
      }
      throw error;
    }
  }
}
