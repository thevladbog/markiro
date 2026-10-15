import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetIntent, UsDatasetReceipt } from "./us-dataset-contract.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";
import { schema } from "@markiro/db";
import { canonicalExportDigest, canonicalExportEqual } from "./us-demo-canonical.js";

import { eq } from "drizzle-orm";
import { parseUsDatasetIntent } from "./us-dataset-contract.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  caseDemoAuditIdentity,
  caseDemoCommandDigest,
  datasetCasesError,
  parseUsDatasetCasesResult,
  usDatasetCasesRecordIds,
} from "./us-dataset-cases-contract.js";
import { prepareUsDatasetCasesCore } from "./us-dataset-cases-prepare.js";
import { verifyUsDatasetCasesContent } from "./us-dataset-cases-verify-content.js";
import type { UsDatasetVerifiedOrigin } from "./us-dataset-shipping-projection.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";
import type { UsDatasetTransformationDependencies } from "./us-dataset-terminal-read-contract.js";

export async function verifyUsDatasetCases(
  ...args: Parameters<typeof verifyUsDatasetCasesOrigin>
): Promise<void> {
  await verifyUsDatasetCasesOrigin(...args);
}

export async function verifyUsDatasetCasesOrigin(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  mode: "fresh" | "replay",
  stores: UsDatasetTransformationStores,
): Promise<UsDatasetVerifiedOrigin> {
  return verifyUsDatasetCasesOriginCore(
    tx,
    context,
    rawIntent,
    rawReceipt,
    mode,
    freshUsDatasetTerminalDependencies(stores),
  );
}

export async function verifyUsDatasetCasesOriginCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  mode: "fresh" | "replay",
  stores: UsDatasetTransformationDependencies,
): Promise<UsDatasetVerifiedOrigin> {
  // Obtain only the installed identifier, then use the existing target guard before
  // touching any caller evidence (including getters). No separate pool read.
  const headers = schema.traceabilityDemoDatasets;
  const [header] = await tx
    .select({ id: headers.id })
    .from(headers)
    .where(eq(headers.tenantId, context.tenantId));
  await stores.journal.readStageInTransaction(
    tx,
    context,
    header?.id ?? "00000000-0000-4000-8000-000000000000",
    "references",
    "references",
  );
  const intent = parseUsDatasetIntent(rawIntent),
    receipt = parseUsDemoReceipt(rawReceipt);
  const mismatch = (cause?: unknown) =>
    datasetCasesError("us_dataset_cases_mismatch", intent.unitKey, cause);
  const equal = (a: unknown, b: unknown) => {
    if (!canonicalExportEqual(a, b)) throw mismatch();
  };
  try {
    const result = parseUsDatasetCasesResult(receipt.result);
    const prepared = await prepareUsDatasetCasesCore(
      tx,
      context,
      result.input.references.datasetId,
      intent.unitKey,
      { mode: mode === "fresh" ? "fresh_verification" : "replay", receipt },
      stores,
    );
    equal(intent, prepared.intent);
    equal(intent.stage, "cases");
    equal(result.input, prepared.input);
    equal(result.operationKey, intent.operationKey);
    equal(receipt.resultDigest, canonicalExportDigest(result));
    equal(receipt.recordIds, usDatasetCasesRecordIds(result));
    await verifyUsDatasetCasesContent(
      tx,
      context,
      result,
      {
        digest: caseDemoCommandDigest(prepared.input),
        seed: caseDemoAuditIdentity(prepared.input),
      },
      (code, cause) => datasetCasesError(code, intent.unitKey, cause),
    );
    return prepared.verifiedOrigin;
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.message.startsWith("us_dataset_") || cause.name === "ZodError")
    )
      throw mismatch(cause);
    throw cause;
  }
}
