import { canonicalExportEqual } from "./us-demo-canonical.js";

import { lockTransformationOperation } from "../transformation/us-transformation-operations.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetIntent } from "./us-dataset-contract.js";
import {
  datasetCorrectedTransformationError,
  makeUsDatasetCorrectedTransformationInput,
  parseUsDatasetCorrectedTransformationInput,
} from "./us-dataset-corrected-transformation-contract.js";
import type { UsDatasetCorrectedTransformationResult } from "./us-dataset-corrected-transformation-result.js";
import type { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { makeUsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import { parseUsDatasetSpecialResult } from "./us-dataset-special-contract.js";
import { verifyUsDatasetSpecialCore } from "./us-dataset-special-verify.js";
import { lockUsDatasetTransformationRows } from "./us-dataset-transformation-locks.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";
import type { UsDatasetTransformationDependencies } from "./us-dataset-terminal-read-contract.js";

/** Read-only authorization has already run; no implicit prerequisite installation. */
export async function readUsDatasetCorrectedTransformationInput(
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
  if (!references?.receipt || !original?.receipt || !amendment?.receipt)
    throw datasetCorrectedTransformationError(
      "us_dataset_corrected_transformation_prerequisite_incomplete",
    );
  return makeUsDatasetCorrectedTransformationInput(
    makeUsDatasetReferenceIdentity(datasetId, references),
    amendment,
  );
}

/** Operations, both owned roots/all revisions, then union lots precede actual current proof. */
export async function prepareUsDatasetCorrectedTransformation(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  stores: UsDatasetTransformationStores,
  known: UsDatasetCorrectedTransformationResult | null,
) {
  return prepareUsDatasetCorrectedTransformationCore(
    tx,
    context,
    intent,
    freshUsDatasetTerminalDependencies(stores),
    known,
  );
}
export async function prepareUsDatasetCorrectedTransformationCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  stores: UsDatasetTransformationDependencies,
  known: UsDatasetCorrectedTransformationResult | null,
) {
  const input = parseUsDatasetCorrectedTransformationInput(intent.input);
  const mismatch = (cause?: unknown) =>
    datasetCorrectedTransformationError("us_dataset_corrected_transformation_mismatch", cause);
  const equal = (a: unknown, b: unknown) => {
    if (!canonicalExportEqual(a, b)) throw mismatch();
  };
  equal(intent.unitKey, "correction_0001");
  equal(intent.stage, "transformation");
  for (const command of ["transformation.create", "transformation.finalize"] as const)
    await lockTransformationOperation(tx, context.tenantId, command, intent.operationKey);
  await lockUsDatasetTransformationRows(
    tx,
    context,
    {
      receivingRootId: input.receivingOrigin.rootId,
      transformationRootId: known?.created.id ?? null,
      lotIds: [
        ...input.receivingOrigin.inputLots.map(({ lotId }) => lotId),
        ...(known ? [known.outputLot.id] : []),
      ],
    },
    mismatch,
  );
  const datasetId = input.references.datasetId;
  const [references, original, amendment] = await stores.journal.readStagesInTransaction(
    tx,
    context,
    datasetId,
    [
      { unitKey: "references", stage: "references" },
      { unitKey: "correction_0001", stage: "receiving" },
      { unitKey: "correction_0001", stage: "amend_receiving" },
    ],
  );
  if (!references?.receipt || !original?.receipt || !amendment?.receipt) throw mismatch();
  equal(
    makeUsDatasetCorrectedTransformationInput(
      makeUsDatasetReferenceIdentity(datasetId, references),
      amendment,
    ),
    input,
  );
  const originalResult = parseUsDatasetSpecialResult(original.receipt.result);
  const lifecycle = parseUsDatasetSpecialResult(amendment.receipt.result);
  if (originalResult.stage !== "receiving" || lifecycle.stage !== "amend_receiving")
    throw mismatch();
  equal(lifecycle.original, originalResult);
  equal(originalResult.input.references, input.references);
  equal(
    lifecycle.lots.map((lot, i) => ({ lineNo: i + 1, lotId: lot.id })),
    input.receivingOrigin.inputLots,
  );
  try {
    await verifyUsDatasetSpecialCore(tx, context, amendment.intent, amendment.receipt, stores);
  } catch (error) {
    if (
      error instanceof Error &&
      ["us_dataset_special_mismatch", "us_dataset_reference_mismatch"].includes(error.message)
    )
      throw mismatch(error);
    throw error;
  }
  return {
    input,
    bindings: parseUsDatasetReferenceResult(references.receipt.result).bindings,
    inputLots: lifecycle.lots,
  };
}
