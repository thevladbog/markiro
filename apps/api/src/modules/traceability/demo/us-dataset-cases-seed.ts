import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { UsCaseStore } from "../cases/us-case-store.js";
import { UsCatalogStore } from "../catalog/us-catalog-store.js";
import { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import { UsLotStore } from "../lots/us-lot-store.js";
import { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import { UsProductProfileStore } from "../products/us-product-profile-store.js";
import { UsReceivingStore } from "../receiving/us-receiving-store.js";
import { UsTransformationStore } from "../transformation/us-transformation-store.js";
import type { UsDatasetContext, UsDatasetStageRow } from "./us-dataset-contract.js";
import {
  datasetCasesError,
  makeUsDatasetCasesInput,
  parseUsDatasetCasesInput,
  parseUsDatasetCasesResult,
  usDatasetCasesRecordIds,
  type UsDatasetCasesResult,
} from "./us-dataset-cases-contract.js";
import { verifyUsDatasetCases } from "./us-dataset-cases-verify.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";
import { makeUsSixMonthRegularChain } from "./us-six-month-chains.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

export class UsDatasetCasesSeedStore {
  private readonly stores: UsDatasetTransformationStores;
  private readonly cases: UsCaseStore;
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
    this.cases = new UsCaseStore(db);
  }
  initialize(context: UsDatasetContext, index: number): Promise<UsDatasetCasesResult> {
    return this.execute(context, index, true);
  }
  verify(context: UsDatasetContext, index: number): Promise<UsDatasetCasesResult> {
    return this.execute(context, index, false);
  }
  private async execute(
    context: UsDatasetContext,
    index: number,
    capture: boolean,
  ): Promise<UsDatasetCasesResult> {
    let unitKey = "unknown";
    try {
      const journal = this.stores.journal;
      // Current actual target/owner authority precedes interpreting the requested index.
      const header = await journal.read(context);
      if (!header) throw datasetCasesError("us_dataset_cases_prerequisite_incomplete", unitKey);
      let chain;
      try {
        chain = makeUsSixMonthRegularChain(index);
        unitKey = chain.unitKey;
      } catch (cause) {
        throw datasetCasesError("us_dataset_cases_input_invalid", unitKey, cause);
      }
      const references = await journal.readStage(context, header.id, "references", "references");
      const receiving = await journal.readStage(context, header.id, unitKey, "receiving");
      const transformation = await journal.readStage(context, header.id, unitKey, "transformation");
      if (!references?.receipt || !receiving?.receipt || !transformation?.receipt)
        throw datasetCasesError("us_dataset_cases_prerequisite_incomplete", unitKey);
      const checkedStage = (stage: UsDatasetStageRow | null) => {
        if (!stage) return null;
        try {
          const captured = parseUsDatasetCasesInput(stage.intent.input);
          const expected = makeUsDatasetCasesInput(
            index,
            header.id,
            references,
            receiving,
            transformation,
            captured.support,
          );
          if (
            stage.unitKey !== unitKey ||
            stage.stage !== "cases" ||
            canonicalExportDigest(captured) !== canonicalExportDigest(expected)
          )
            throw datasetCasesError("us_dataset_cases_dependency_conflict", unitKey);
        } catch (cause) {
          throw datasetCasesError("us_dataset_cases_dependency_conflict", unitKey, cause);
        }
        return stage;
      };
      let stage = checkedStage(await journal.readStage(context, header.id, unitKey, "cases"));
      if (!stage && capture) {
        const capturedAt = new Date().toISOString();
        const input = makeUsDatasetCasesInput(
          index,
          header.id,
          references,
          receiving,
          transformation,
          {
            capturedAt,
            shiftId: randomUUID(),
            numberMonthKey:
              new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
                .format(new Date(capturedAt))
                .toUpperCase() + capturedAt.slice(2, 4),
            numberSeq: index + 1,
            boxes: chain.cases.map((sscc) => ({
              id: randomUUID(),
              deviceBoxId: randomUUID(),
              sscc,
            })),
          },
        );
        const intent = {
          unitKey,
          stage: "cases" as const,
          operationKey: randomUUID(),
          input,
          inputDigest: canonicalExportDigest(input),
        };
        try {
          stage = checkedStage(await journal.captureIntent(context, header.id, intent));
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "us_dataset_intent_conflict")
            throw error;
          // Another capture owns its support and operation identity. Discard our candidate.
          stage = checkedStage(await journal.readStage(context, header.id, unitKey, "cases"));
          if (!stage) throw error;
        }
      }
      if (!stage || (!capture && !stage.receipt))
        throw datasetCasesError("us_dataset_cases_prerequisite_incomplete", unitKey);
      // Fresh evidence cannot adopt existing pending writes: only this apply can enable it.
      let applied = false;
      const completed = await journal.runAtomicStage(
        context,
        header.id,
        stage.revision,
        stage.intent,
        {
          apply: async (tx, checked, intent) => {
            if (!capture)
              throw datasetCasesError("us_dataset_cases_prerequisite_incomplete", unitKey);
            const requestId = `dataset-cases:${intent.operationKey}`;
            const application = await this.cases.seedDemoInTransaction(
              tx,
              checked,
              header.id,
              intent.unitKey,
              requestId,
            );
            const result = parseUsDatasetCasesResult({
              input: application.input,
              support: application.support,
              operationKey: intent.operationKey,
              requestId,
              linked: application.linked,
            });
            const receipt = {
              recordIds: usDatasetCasesRecordIds(result),
              result,
              resultDigest: canonicalExportDigest(result),
            };
            applied = true;
            return receipt;
          },
          verify: (tx, checked, intent, receipt) =>
            verifyUsDatasetCases(
              tx,
              checked,
              intent,
              receipt,
              applied ? "fresh" : "replay",
              this.stores,
            ),
        },
      );
      if (!completed.receipt)
        throw datasetCasesError("us_dataset_cases_prerequisite_incomplete", unitKey);
      return parseUsDatasetCasesResult(completed.receipt.result);
    } catch (error) {
      if (error instanceof Error && Object.isExtensible(error)) {
        try {
          Object.defineProperties(error, {
            unitKey: { value: unitKey, enumerable: true, configurable: true, writable: true },
            stage: { value: "cases", enumerable: true, configurable: true, writable: true },
          });
        } catch {
          // A nonconfigurable annotation must not replace the original driver/domain error.
        }
      }
      throw error;
    }
  }
}
