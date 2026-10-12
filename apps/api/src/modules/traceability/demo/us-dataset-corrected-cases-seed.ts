import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { linkPreparedDemoCasesInTransaction } from "../cases/us-case-demo-content.js";
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
import type { UsDatasetCasesContentError } from "./us-dataset-cases-content.js";
import { insertUsDatasetCasesSupport } from "./us-dataset-cases-support.js";
import {
  makeUsDatasetCorrectedCasesInput,
  parseUsDatasetCorrectedCasesInput,
} from "./us-dataset-corrected-cases-contract.js";
import {
  authorizeUsDatasetCorrectedCases,
  prepareUsDatasetCorrectedCases,
  readUsDatasetCorrectedCasesPrerequisites,
} from "./us-dataset-corrected-cases-prepare.js";
import {
  correctedCaseDemoAuditIdentity,
  correctedCaseDemoCommandDigest,
  datasetCorrectedCasesError,
  parseUsDatasetCorrectedCasesResult,
  usDatasetCorrectedCasesRecordIds,
  type UsDatasetCorrectedCasesResult,
} from "./us-dataset-corrected-cases-result.js";
import { verifyUsDatasetCorrectedCases } from "./us-dataset-corrected-cases-verify.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { makeUsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";
import { makeUsSixMonthSpecialExamples, usSixMonthDefinition } from "./us-six-month-definition.js";

/** Fixed corrected recipe; installed completed prerequisites are never implicitly created. */
export class UsDatasetCorrectedCasesSeedStore {
  private readonly stores: UsDatasetTransformationStores;
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
    };
  }
  initialize(context: UsDatasetContext): Promise<UsDatasetCorrectedCasesResult> {
    return this.execute(context, true);
  }
  verify(context: UsDatasetContext): Promise<UsDatasetCorrectedCasesResult> {
    return this.execute(context, false);
  }
  private async execute(
    context: UsDatasetContext,
    capture: boolean,
  ): Promise<UsDatasetCorrectedCasesResult> {
    const incomplete = () =>
      datasetCorrectedCasesError("us_dataset_corrected_cases_prerequisite_incomplete");
    const error: UsDatasetCasesContentError = (code, cause) =>
      datasetCorrectedCasesError(
        code === "us_dataset_cases_conflict"
          ? "us_dataset_corrected_cases_conflict"
          : "us_dataset_corrected_cases_mismatch",
        cause,
      );
    try {
      const journal = this.stores.journal;
      const header = await journal.read(context);
      if (!header) throw incomplete();
      await this.db.transaction((tx) => authorizeUsDatasetCorrectedCases(tx, context, this.stores));
      const { references, amendment, transformation } =
        await readUsDatasetCorrectedCasesPrerequisites(journal, context, header.id);
      const reconstruct = (support: unknown) =>
        makeUsDatasetCorrectedCasesInput(
          makeUsDatasetReferenceIdentity(header.id, references),
          amendment,
          transformation,
          support,
        );
      const checked = (stage: UsDatasetStageRow | null) => {
        if (stage) {
          const input = parseUsDatasetCorrectedCasesInput(stage.intent.input);
          if (
            stage.unitKey !== "correction_0001" ||
            stage.stage !== "cases" ||
            canonicalExportDigest(input) !== canonicalExportDigest(reconstruct(input.support))
          )
            throw datasetCorrectedCasesError("us_dataset_corrected_cases_dependency_conflict");
        }
        return stage;
      };
      let stage = checked(await journal.readStage(context, header.id, "correction_0001", "cases"));
      if (!stage && capture) {
        const capturedAt = new Date().toISOString();
        const input = reconstruct({
          capturedAt,
          shiftId: randomUUID(),
          numberMonthKey:
            new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
              .format(new Date(capturedAt))
              .toUpperCase() + capturedAt.slice(2, 4),
          numberSeq: 261,
          boxes: makeUsSixMonthSpecialExamples().correction.correctedChain.cases.map((sscc) => ({
            id: randomUUID(),
            deviceBoxId: randomUUID(),
            sscc,
          })),
        });
        const intent: UsDatasetIntent = {
          unitKey: "correction_0001",
          stage: "cases",
          operationKey: randomUUID(),
          input,
          inputDigest: canonicalExportDigest(input),
        };
        try {
          stage = checked(await journal.captureIntent(context, header.id, intent));
        } catch (cause) {
          if (!(cause instanceof Error) || cause.message !== "us_dataset_intent_conflict")
            throw cause;
          stage = checked(await journal.readStage(context, header.id, "correction_0001", "cases"));
          if (!stage) throw cause;
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
            const prepared = await prepareUsDatasetCorrectedCases(
              tx,
              checkedContext,
              intent,
              { mode: "application" },
              this.stores,
            );
            const support = await insertUsDatasetCasesSupport(
              tx,
              checkedContext,
              prepared.input,
              error,
            );
            const requestId = `dataset-cases:${intent.operationKey}`;
            const linked = await linkPreparedDemoCasesInTransaction(
              tx,
              checkedContext,
              prepared.input,
              intent.operationKey,
              requestId,
              {
                digest: correctedCaseDemoCommandDigest(prepared.input),
                seed: correctedCaseDemoAuditIdentity(prepared.input),
              },
              null,
              error,
            );
            const result = parseUsDatasetCorrectedCasesResult({
              input: prepared.input,
              support,
              operationKey: intent.operationKey,
              requestId,
              linked,
            });
            applied = true;
            return {
              result,
              resultDigest: canonicalExportDigest(result),
              recordIds: usDatasetCorrectedCasesRecordIds(result),
            };
          },
          verify: (tx, checkedContext, intent, receipt) =>
            verifyUsDatasetCorrectedCases(
              tx,
              checkedContext,
              intent,
              receipt,
              applied ? "fresh" : "replay",
              this.stores,
            ),
        },
      );
      if (!completed.receipt) throw incomplete();
      return parseUsDatasetCorrectedCasesResult(completed.receipt.result);
    } catch (cause) {
      if (cause instanceof Error && Object.isExtensible(cause)) {
        try {
          Object.defineProperties(cause, {
            unitKey: {
              value: "correction_0001",
              enumerable: true,
              configurable: true,
              writable: true,
            },
            stage: { value: "cases", enumerable: true, configurable: true, writable: true },
          });
        } catch {
          /* Preserve original driver/domain errors. */
        }
      }
      throw cause;
    }
  }
}
