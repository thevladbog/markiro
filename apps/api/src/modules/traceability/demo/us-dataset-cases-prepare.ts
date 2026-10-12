import { schema } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import { and, eq, sql } from "drizzle-orm";
import { authorizeUsMasterData } from "../master-data/us-master-data-support.js";
import { lockCaseOperation } from "../cases/us-case-operations.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type {
  UsDatasetContext,
  UsDatasetIntent,
  UsDatasetReceipt,
  UsDatasetStageRow,
} from "./us-dataset-contract.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  caseDemoCommandDigest,
  datasetCasesError,
  makeUsDatasetCasesInput,
  parseUsDatasetCasesInput,
  parseUsDatasetCasesResult,
  usDatasetCasesRecordIds,
  type UsDatasetCasesInput,
} from "./us-dataset-cases-contract.js";
import { parseUsDatasetReceivingResult } from "./us-dataset-receiving-contract.js";
import { parseUsDatasetTransformationResult } from "./us-dataset-transformation-contract.js";
import { lockUsDatasetTransformation } from "./us-dataset-transformation-locks.js";
import {
  verifyUsDatasetTransformation,
  type UsDatasetTransformationStores,
} from "./us-dataset-transformation-verify.js";

export type UsDatasetCasesPrepared = Readonly<{
  input: UsDatasetCasesInput;
  intent: UsDatasetIntent;
  cases: UsDatasetStageRow;
  references: UsDatasetStageRow;
  receiving: UsDatasetStageRow;
  transformation: UsDatasetStageRow;
}>;
export type UsDatasetCasesPreparation =
  | Readonly<{ mode: "application" }>
  | Readonly<{ mode: "fresh_verification"; receipt: UsDatasetReceipt }>
  | Readonly<{ mode: "replay"; receipt: UsDatasetReceipt }>;

/** All dependencies are real stores; every call below uses only the supplied transaction. */
export async function prepareUsDatasetCases(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  datasetId: string,
  unitKey: string,
  phase: UsDatasetCasesPreparation,
  stores: UsDatasetTransformationStores,
): Promise<UsDatasetCasesPrepared> {
  // Constant stage first: current actual-target/owner/profile authorization precedes raw unit input.
  await stores.journal.readStageInTransaction(tx, context, datasetId, "references", "references");
  await authorizeUsMasterData(
    tx,
    context.tenantId,
    context.actorUserId,
    US_CAPABILITY.TRANSFORMATION_WRITE,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":us-processor-demo-v1"}, 0))`,
  );
  const headers = schema.traceabilityDemoDatasets,
    stages = schema.traceabilityDemoDatasetStages;
  await tx
    .select({ id: headers.id })
    .from(headers)
    .where(eq(headers.tenantId, context.tenantId))
    .for("update");
  await tx
    .select({ unitKey: stages.unitKey })
    .from(stages)
    .where(
      and(
        eq(stages.tenantId, context.tenantId),
        eq(stages.datasetId, datasetId),
        eq(stages.unitKey, unitKey),
        eq(stages.stage, "cases"),
      ),
    )
    .for("update");
  const cases = await stores.journal.readStageInTransaction(
    tx,
    context,
    datasetId,
    unitKey,
    "cases",
  );
  const fail = () => datasetCasesError("us_dataset_cases_conflict", unitKey);
  const equal = (a: unknown, b: unknown) => {
    if (canonicalExportDigest(a) !== canonicalExportDigest(b)) throw fail();
  };
  if (!cases) throw datasetCasesError("us_dataset_cases_prerequisite_incomplete", unitKey);
  const intent = cases.intent,
    input = parseUsDatasetCasesInput(intent.input);
  equal(input.transformation.unitKey, unitKey);
  equal(input.references.datasetId, datasetId);
  const [references, receiving, transformation] = await stores.journal.readStagesInTransaction(
    tx,
    context,
    datasetId,
    [
      { unitKey: "references", stage: "references" },
      { unitKey: unitKey, stage: "receiving" },
      { unitKey: unitKey, stage: "transformation" },
    ],
  );
  if (!references?.receipt || !receiving?.receipt || !transformation?.receipt)
    throw datasetCasesError("us_dataset_cases_prerequisite_incomplete", unitKey);
  equal(
    input,
    makeUsDatasetCasesInput(
      input.index,
      datasetId,
      references,
      receiving,
      transformation,
      input.support,
    ),
  );
  // Cases operation arbitration MUST precede any verifier or origin root/lot lock.
  const operation = await lockCaseOperation(tx, context.tenantId, "case.link", intent.operationKey);
  let receipt: UsDatasetReceipt | null = cases.receipt;
  if (phase.mode === "fresh_verification") {
    if (cases.receipt !== null || cases.revision !== 1) throw fail();
    receipt = parseUsDemoReceipt(phase.receipt);
  } else if (phase.mode === "replay") {
    if (!cases.receipt) throw fail();
    equal(parseUsDemoReceipt(phase.receipt), cases.receipt);
  }
  if (receipt) {
    const result = parseUsDatasetCasesResult(receipt.result);
    equal(result.input, input);
    equal(result.operationKey, intent.operationKey);
    equal(receipt.resultDigest, canonicalExportDigest(result));
    equal(receipt.recordIds, usDatasetCasesRecordIds(result));
    if (!operation) throw fail();
    equal(
      { digest: operation.inputDigest, target: operation.targetId, result: operation.result },
      { digest: caseDemoCommandDigest(input), target: input.outputLotId, result: result.linked },
    );
    if (result.linked.created.some((row) => row.linkedBy !== context.actorUserId)) throw fail();
  } else if (operation) throw fail();
  await lockUsDatasetTransformation(tx, context, {
    receiving: parseUsDatasetReceivingResult(receiving.receipt.result),
    transformation: parseUsDatasetTransformationResult(transformation.receipt.result),
  });
  await verifyUsDatasetTransformation(
    tx,
    context,
    transformation.intent,
    transformation.receipt,
    stores,
    "replay",
  );
  return { input, intent, cases, references, receiving, transformation };
}
