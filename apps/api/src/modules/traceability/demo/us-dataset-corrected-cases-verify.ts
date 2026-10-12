import { canonicalExportDigest } from "@markiro/domain";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetIntent, UsDatasetReceipt } from "./us-dataset-contract.js";
import { parseUsDatasetIntent } from "./us-dataset-contract.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  correctedCaseDemoAuditIdentity,
  correctedCaseDemoCommandDigest,
  datasetCorrectedCasesError,
  parseUsDatasetCorrectedCasesResult,
  usDatasetCorrectedCasesRecordIds,
} from "./us-dataset-corrected-cases-result.js";
import {
  authorizeUsDatasetCorrectedCases,
  prepareUsDatasetCorrectedCases,
} from "./us-dataset-corrected-cases-prepare.js";
import { verifyUsDatasetCasesContent } from "./us-dataset-cases-verify-content.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";

/** A fresh candidate is available only after this invocation's private business writes. */
export async function verifyUsDatasetCorrectedCases(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  mode: "fresh" | "replay",
  stores: UsDatasetTransformationStores,
): Promise<void> {
  await authorizeUsDatasetCorrectedCases(tx, context, stores);
  const mismatch = (cause?: unknown) =>
    datasetCorrectedCasesError("us_dataset_corrected_cases_mismatch", cause);
  const equal = (a: unknown, b: unknown) => {
    if (canonicalExportDigest(a) !== canonicalExportDigest(b)) throw mismatch();
  };
  try {
    const intent = parseUsDatasetIntent(rawIntent),
      receipt = parseUsDemoReceipt(rawReceipt),
      result = parseUsDatasetCorrectedCasesResult(receipt.result);
    const prepared = await prepareUsDatasetCorrectedCases(
      tx,
      context,
      intent,
      { mode: mode === "fresh" ? "fresh_verification" : "replay", receipt },
      stores,
    );
    equal(intent, prepared.intent);
    equal(result.input, prepared.input);
    equal(result.operationKey, intent.operationKey);
    equal(receipt.resultDigest, canonicalExportDigest(result));
    equal(receipt.recordIds, usDatasetCorrectedCasesRecordIds(result));
    await verifyUsDatasetCasesContent(
      tx,
      context,
      result,
      {
        digest: correctedCaseDemoCommandDigest(prepared.input),
        seed: correctedCaseDemoAuditIdentity(prepared.input),
      },
      (code, cause) =>
        datasetCorrectedCasesError(
          code === "us_dataset_cases_conflict"
            ? "us_dataset_corrected_cases_conflict"
            : "us_dataset_corrected_cases_mismatch",
          cause,
        ),
    );
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.message.startsWith("us_dataset_") || cause.name === "ZodError")
    )
      throw mismatch(cause);
    throw cause;
  }
}
