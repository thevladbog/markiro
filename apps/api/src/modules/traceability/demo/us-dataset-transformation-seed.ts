import { verifyUsDatasetTransformationFinal } from "./us-dataset-native-final-verify.js";
import { applyUsDatasetTransformationContent } from "./us-dataset-transformation-apply-content.js";
import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";

import { canonicalExportDigest, canonicalExportEqual } from "./us-demo-canonical.js";
import { UsCatalogStore } from "../catalog/us-catalog-store.js";
import { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import { UsLotStore } from "../lots/us-lot-store.js";
import { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import { UsProductProfileStore } from "../products/us-product-profile-store.js";
import { UsReceivingStore } from "../receiving/us-receiving-store.js";
import { UsTransformationStore } from "../transformation/us-transformation-store.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type {
  UsDatasetContext,
  UsDatasetIntent,
  UsDatasetReceipt,
  UsDatasetStageRow,
} from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import {
  makeUsDatasetReferenceIdentity,
  parseUsDatasetReceivingResult,
} from "./us-dataset-receiving-contract.js";
import { verifyUsDatasetReceiving } from "./us-dataset-receiving-verify.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import {
  datasetTransformationError,
  makeUsDatasetReceivingIdentity,
  makeUsDatasetTransformationInput,
  parseUsDatasetTransformationInput,
  parseUsDatasetTransformationResult,
  usDatasetTransformationRecordIds,
  type UsDatasetTransformationInput,
  type UsDatasetTransformationResult,
} from "./us-dataset-transformation-contract.js";
import { lockUsDatasetTransformation } from "./us-dataset-transformation-locks.js";
import { type UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import { makeUsSixMonthRegularChain } from "./us-six-month-chains.js";

const same = (a: unknown, b: unknown) => canonicalExportEqual(a, b);
function checkedStage(stage: UsDatasetStageRow | null, input: UsDatasetTransformationInput) {
  if (
    stage &&
    (stage.unitKey !== input.chain.unitKey ||
      stage.stage !== "transformation" ||
      !same(stage.intent.input, input))
  )
    throw datasetTransformationError(
      "us_dataset_transformation_dependency_conflict",
      input.chain.unitKey,
    );
  return stage;
}

/** Internal bounded executor: prerequisites must already be installed. */
export class UsDatasetTransformationSeedStore {
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
  initialize(context: UsDatasetContext, index: number): Promise<UsDatasetTransformationResult> {
    return this.execute(context, index, true);
  }
  verify(context: UsDatasetContext, index: number): Promise<UsDatasetTransformationResult> {
    return this.execute(context, index, false);
  }
  private async execute(
    context: UsDatasetContext,
    index: number,
    capture: boolean,
  ): Promise<UsDatasetTransformationResult> {
    let unitKey = "unknown";
    try {
      const journal = this.stores.journal;
      // Reauthorize the real target and current owner before parsing index/evidence.
      const header = await journal.read(context);
      if (!header)
        throw datasetTransformationError(
          "us_dataset_transformation_prerequisite_incomplete",
          "unknown",
        );
      try {
        unitKey = makeUsSixMonthRegularChain(index).unitKey;
      } catch (cause) {
        throw datasetTransformationError(
          "us_dataset_transformation_input_invalid",
          "unknown",
          cause,
        );
      }
      const references = await journal.readStage(context, header.id, "references", "references");
      const receiving = await journal.readStage(context, header.id, unitKey, "receiving");
      if (!references?.receipt || !receiving?.receipt)
        throw datasetTransformationError(
          "us_dataset_transformation_prerequisite_incomplete",
          unitKey,
        );
      const input = makeUsDatasetTransformationInput(
        index,
        makeUsDatasetReferenceIdentity(header.id, references),
        makeUsDatasetReceivingIdentity(header.id, receiving),
      );
      let stage = checkedStage(
        await journal.readStage(context, header.id, unitKey, "transformation"),
        input,
      );
      if (!stage && capture) {
        const intent: UsDatasetIntent = {
          unitKey,
          stage: "transformation",
          operationKey: randomUUID(),
          input,
          inputDigest: canonicalExportDigest(input),
        };
        try {
          stage = checkedStage(await journal.captureIntent(context, header.id, intent), input);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "us_dataset_intent_conflict")
            throw error;
          stage = checkedStage(
            await journal.readStage(context, header.id, unitKey, "transformation"),
            input,
          );
          if (!stage) throw error;
        }
      }
      if (!stage || (!capture && !stage.receipt))
        throw datasetTransformationError(
          "us_dataset_transformation_prerequisite_incomplete",
          unitKey,
        );
      // Only this invocation's successfully applied private rows may use fresh mode.
      let applied = false;
      const completed = await journal.runAtomicStage(
        context,
        header.id,
        stage.revision,
        stage.intent,
        {
          apply: async (tx, checked, intent) => {
            if (!capture)
              throw datasetTransformationError(
                "us_dataset_transformation_prerequisite_incomplete",
                unitKey,
              );
            const receipt = await this.apply(tx, checked, intent);
            applied = true;
            return receipt;
          },
          verify: (tx, checked, intent, receipt) =>
            verifyUsDatasetTransformationFinal(
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
        throw datasetTransformationError(
          "us_dataset_transformation_prerequisite_incomplete",
          unitKey,
        );
      return parseUsDatasetTransformationResult(completed.receipt.result);
    } catch (error) {
      // Retain the original driver/domain failure and cause. Context contains
      // only guarded bounded identity, never payloads or query diagnostics.
      if (error instanceof Error && Object.isExtensible(error)) {
        try {
          Object.defineProperties(error, {
            unitKey: { value: unitKey, enumerable: true, configurable: true, writable: true },
            stage: {
              value: "transformation",
              enumerable: true,
              configurable: true,
              writable: true,
            },
          });
        } catch {
          // An annotation failure must not replace a non-configurable primary error.
        }
      }
      throw error;
    }
  }
  private async apply(
    tx: UsDemoTransaction,
    context: UsDatasetContext,
    intent: UsDatasetIntent,
  ): Promise<UsDatasetReceipt> {
    const input = parseUsDatasetTransformationInput(intent.input);
    const fail = () =>
      datasetTransformationError("us_dataset_transformation_conflict", intent.unitKey);
    const references = await this.stores.journal.readStageInTransaction(
      tx,
      context,
      input.references.datasetId,
      "references",
      "references",
    );
    const receiving = await this.stores.journal.readStageInTransaction(
      tx,
      context,
      input.receiving.datasetId,
      input.receiving.unitKey,
      "receiving",
    );
    if (
      !references?.receipt ||
      !receiving?.receipt ||
      !same(
        makeUsDatasetReferenceIdentity(input.references.datasetId, references),
        input.references,
      ) ||
      !same(makeUsDatasetReceivingIdentity(input.receiving.datasetId, receiving), input.receiving)
    )
      throw datasetTransformationError(
        "us_dataset_transformation_dependency_conflict",
        intent.unitKey,
      );
    const upstream = parseUsDatasetReceivingResult(receiving.receipt.result);
    if (
      !same(upstream.input.chain, input.chain) ||
      !same(upstream.input.references, input.references)
    )
      throw datasetTransformationError(
        "us_dataset_transformation_dependency_conflict",
        intent.unitKey,
      );
    await lockUsDatasetTransformation(tx, context, { receiving: upstream, transformation: null });
    try {
      await verifyUsDatasetReceiving(tx, context, receiving.intent, receiving.receipt, this.stores);
    } catch (cause) {
      if (
        cause instanceof Error &&
        ["us_dataset_receiving_mismatch", "us_dataset_reference_mismatch"].includes(cause.message)
      )
        throw datasetTransformationError(
          "us_dataset_transformation_mismatch",
          intent.unitKey,
          cause,
        );
      throw cause;
    }
    const bindings = parseUsDatasetReferenceResult(references.receipt.result).bindings;
    const evidence = await applyUsDatasetTransformationContent(
      tx,
      context,
      intent.operationKey,
      input.chain,
      bindings,
      upstream.lots,
      this.stores,
      fail,
    );
    const result = parseUsDatasetTransformationResult({ input, ...evidence });
    return {
      result,
      resultDigest: canonicalExportDigest(result),
      recordIds: usDatasetTransformationRecordIds(result),
    };
  }
}
