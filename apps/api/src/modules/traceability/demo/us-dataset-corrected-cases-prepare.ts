import { schema } from "@markiro/db";
import { canonicalExportDigest, US_CAPABILITY } from "@markiro/domain";
import { and, eq, sql } from "drizzle-orm";
import { lockCaseOperation } from "../cases/us-case-operations.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetIntent, UsDatasetReceipt } from "./us-dataset-contract.js";
import { parseUsDatasetIntent } from "./us-dataset-contract.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  makeUsDatasetCorrectedCasesInput,
  parseUsDatasetCorrectedCasesInput,
} from "./us-dataset-corrected-cases-contract.js";
import {
  correctedCaseDemoCommandDigest,
  datasetCorrectedCasesError,
  parseUsDatasetCorrectedCasesResult,
  usDatasetCorrectedCasesRecordIds,
} from "./us-dataset-corrected-cases-result.js";
import { verifyUsDatasetCorrectedTransformationCore } from "./us-dataset-corrected-transformation-verify.js";
import { makeUsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import type { UsDatasetJournalStore } from "./us-dataset-journal.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";
import type { UsDatasetCasesPreparation } from "./us-dataset-cases-prepare.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";
import type { UsDatasetTransformationDependencies } from "./us-dataset-terminal-read-contract.js";

/** Actual target/owner/profile and current capability precede any caller evidence. */
export async function authorizeUsDatasetCorrectedCases(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  stores: UsDatasetTransformationStores,
): Promise<string> {
  return authorizeUsDatasetCorrectedCasesCore(
    tx,
    context,
    freshUsDatasetTerminalDependencies(stores),
  );
}
export async function authorizeUsDatasetCorrectedCasesCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  stores: UsDatasetTransformationDependencies,
): Promise<string> {
  const header = await stores.journal.readHeaderInTransaction(tx, context);
  await stores.authorize(
    tx,
    context.tenantId,
    context.actorUserId,
    US_CAPABILITY.TRANSFORMATION_WRITE,
  );
  if (!header)
    throw datasetCorrectedCasesError("us_dataset_corrected_cases_prerequisite_incomplete");
  return header.id;
}

/** Read-only capture reconstruction; callers have already authorized the installed journal. */
export async function readUsDatasetCorrectedCasesPrerequisites(
  journal: UsDatasetJournalStore,
  context: UsDatasetContext,
  datasetId: string,
) {
  const references = await journal.readStage(context, datasetId, "references", "references");
  const original = await journal.readStage(context, datasetId, "correction_0001", "receiving");
  const amendment = await journal.readStage(
    context,
    datasetId,
    "correction_0001",
    "amend_receiving",
  );
  const transformation = await journal.readStage(
    context,
    datasetId,
    "correction_0001",
    "transformation",
  );
  if (!references?.receipt || !original?.receipt || !amendment?.receipt || !transformation?.receipt)
    throw datasetCorrectedCasesError("us_dataset_corrected_cases_prerequisite_incomplete");
  return { references, original, amendment, transformation };
}

/** No pool reads: journal arbitration, Cases operation, corrected origins/lots, then support. */
export async function prepareUsDatasetCorrectedCases(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  phase: UsDatasetCasesPreparation,
  stores: UsDatasetTransformationStores,
) {
  return prepareUsDatasetCorrectedCasesCore(
    tx,
    context,
    rawIntent,
    phase,
    freshUsDatasetTerminalDependencies(stores),
  );
}
export async function prepareUsDatasetCorrectedCasesCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  phase: UsDatasetCasesPreparation,
  stores: UsDatasetTransformationDependencies,
) {
  const datasetId = await authorizeUsDatasetCorrectedCasesCore(tx, context, stores);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":us-processor-demo-v1"}, 0))`,
  );
  const headers = schema.traceabilityDemoDatasets,
    stages = schema.traceabilityDemoDatasetStages;
  await tx
    .select({ id: headers.id })
    .from(headers)
    .where(and(eq(headers.tenantId, context.tenantId), eq(headers.id, datasetId)))
    .for("update");
  await tx
    .select({ unitKey: stages.unitKey })
    .from(stages)
    .where(
      and(
        eq(stages.tenantId, context.tenantId),
        eq(stages.datasetId, datasetId),
        eq(stages.unitKey, "correction_0001"),
        eq(stages.stage, "cases"),
      ),
    )
    .for("update");
  const cases = await stores.journal.readStageInTransaction(
    tx,
    context,
    datasetId,
    "correction_0001",
    "cases",
  );
  const fail = () => datasetCorrectedCasesError("us_dataset_corrected_cases_conflict");
  const equal = (a: unknown, b: unknown) => {
    if (canonicalExportDigest(a) !== canonicalExportDigest(b)) throw fail();
  };
  if (!cases)
    throw datasetCorrectedCasesError("us_dataset_corrected_cases_prerequisite_incomplete");
  const intent = parseUsDatasetIntent(rawIntent),
    input = parseUsDatasetCorrectedCasesInput(intent.input);
  equal(intent, cases.intent);
  equal(intent.unitKey, "correction_0001");
  equal(intent.stage, "cases");
  equal(input.references.datasetId, datasetId);
  const [references, original, amendment, transformation] =
    await stores.journal.readStagesInTransaction(tx, context, datasetId, [
      { unitKey: "references", stage: "references" },
      { unitKey: "correction_0001", stage: "receiving" },
      { unitKey: "correction_0001", stage: "amend_receiving" },
      { unitKey: "correction_0001", stage: "transformation" },
    ]);
  if (!references?.receipt || !original?.receipt || !amendment?.receipt || !transformation?.receipt)
    throw datasetCorrectedCasesError("us_dataset_corrected_cases_prerequisite_incomplete");
  equal(
    input,
    makeUsDatasetCorrectedCasesInput(
      makeUsDatasetReferenceIdentity(datasetId, references),
      amendment,
      transformation,
      input.support,
    ),
  );
  const priorIds = new Set(
    [references, original, amendment, transformation].flatMap(
      (stage) => stage.receipt?.recordIds ?? [],
    ),
  );
  if (
    [input.support.shiftId, ...input.support.boxes.map(({ id }) => id)].some((id) =>
      priorIds.has(id),
    )
  )
    throw fail();
  // This lock must be held before the corrected verifier's operations, roots and lots.
  const operation = await lockCaseOperation(tx, context.tenantId, "case.link", intent.operationKey);
  let receipt: UsDatasetReceipt | null = cases.receipt;
  if (phase.mode === "fresh_verification") {
    if (cases.receipt !== null || cases.revision !== 1) throw fail();
    receipt = parseUsDemoReceipt(phase.receipt);
  } else if (phase.mode === "replay") {
    if (!cases.receipt) throw fail();
    equal(parseUsDemoReceipt(phase.receipt), cases.receipt);
  } else if (cases.receipt) throw fail();
  if (receipt) {
    const result = parseUsDatasetCorrectedCasesResult(receipt.result);
    equal(result.input, input);
    equal(result.operationKey, intent.operationKey);
    equal(result.requestId, `dataset-cases:${intent.operationKey}`);
    equal(receipt.resultDigest, canonicalExportDigest(result));
    equal(receipt.recordIds, usDatasetCorrectedCasesRecordIds(result));
    if (receipt.recordIds.some((id) => priorIds.has(id)) || !operation) throw fail();
    equal(
      { digest: operation.inputDigest, target: operation.targetId, result: operation.result },
      {
        digest: correctedCaseDemoCommandDigest(input),
        target: input.outputLotId,
        result: result.linked,
      },
    );
    if (result.linked.created.some((row) => row.linkedBy !== context.actorUserId)) throw fail();
  } else if (operation) throw fail();
  await verifyUsDatasetCorrectedTransformationCore(
    tx,
    context,
    transformation.intent,
    transformation.receipt,
    stores,
    "replay",
  );
  return { input, intent, cases, references, original, amendment, transformation };
}
