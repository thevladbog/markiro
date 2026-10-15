import { canonicalExportDigest, canonicalExportEqual } from "./us-demo-canonical.js";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import {
  parseUsDatasetIntent,
  type UsDatasetContext,
  type UsDatasetIntent,
  type UsDatasetReceipt,
} from "./us-dataset-contract.js";
import { datasetCorrectedTransformationError } from "./us-dataset-corrected-transformation-contract.js";
import { prepareUsDatasetCorrectedTransformationCore } from "./us-dataset-corrected-transformation-prepare.js";
import {
  parseUsDatasetCorrectedTransformationResult,
  usDatasetCorrectedTransformationRecordIds,
} from "./us-dataset-corrected-transformation-result.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import { usDatasetReceivingLotIdentity } from "./us-dataset-receiving-contract.js";
import { verifyUsDatasetTransformationContentCore } from "./us-dataset-transformation-verify-content.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";
import type { UsDatasetTransformationDependencies } from "./us-dataset-terminal-read-contract.js";

/** Fresh mode is restricted to this invocation's successfully applied private native rows. */
export async function verifyUsDatasetCorrectedTransformation(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  stores: UsDatasetTransformationStores,
  mode: "fresh" | "replay",
): Promise<void> {
  return verifyUsDatasetCorrectedTransformationCore(
    tx,
    context,
    rawIntent,
    rawReceipt,
    freshUsDatasetTerminalDependencies(stores),
    mode,
  );
}
export async function verifyUsDatasetCorrectedTransformationCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  stores: UsDatasetTransformationDependencies,
  mode: "fresh" | "replay",
): Promise<void> {
  const mismatch = (cause?: unknown) =>
    datasetCorrectedTransformationError("us_dataset_corrected_transformation_mismatch", cause);
  const equal = (a: unknown, b: unknown) => {
    if (!canonicalExportEqual(a, b)) throw mismatch();
  };
  const intent = parseUsDatasetIntent(rawIntent);
  const receipt = parseUsDemoReceipt(rawReceipt);
  const result = parseUsDatasetCorrectedTransformationResult(receipt.result);
  equal(intent.unitKey, "correction_0001");
  equal(intent.stage, "transformation");
  equal(intent.input, result.input);
  equal(intent.operationKey, result.createInput.operationKey);
  equal(intent.operationKey, result.finalizeInput.operationKey);
  equal(receipt.recordIds, usDatasetCorrectedTransformationRecordIds(result));
  equal(receipt.resultDigest, canonicalExportDigest(result));
  try {
    const prepared = await prepareUsDatasetCorrectedTransformationCore(
      tx,
      context,
      intent,
      stores,
      mode === "replay" ? result : null,
    );
    await verifyUsDatasetTransformationContentCore(
      tx,
      context,
      intent,
      result,
      prepared.bindings,
      prepared.inputLots,
      stores,
      (current) => {
        equal(
          usDatasetReceivingLotIdentity(current),
          usDatasetReceivingLotIdentity(result.outputLot),
        );
        return Promise.resolve();
      },
      mismatch,
    );
  } catch (error) {
    if (
      error instanceof NotFoundException ||
      error instanceof ServiceUnavailableException ||
      (error instanceof Error &&
        (error.name === "ZodError" ||
          [
            "us_dataset_special_mismatch",
            "us_dataset_reference_mismatch",
            "us_dataset_corrected_transformation_dependency_conflict",
          ].includes(error.message)))
    )
      throw mismatch(error);
    throw error;
  }
}
