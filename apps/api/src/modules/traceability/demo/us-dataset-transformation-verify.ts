import { verifyUsDatasetTransformationContentCore } from "./us-dataset-transformation-verify-content.js";
import { canonicalExportDigest, canonicalExportEqual } from "./us-demo-canonical.js";

import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { UsTransformationStore } from "../transformation/us-transformation-store.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import {
  parseUsDatasetIntent,
  type UsDatasetContext,
  type UsDatasetIntent,
  type UsDatasetReceipt,
} from "./us-dataset-contract.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  makeUsDatasetReferenceIdentity,
  parseUsDatasetReceivingResult,
} from "./us-dataset-receiving-contract.js";
import {
  verifyUsDatasetReceivingResultCore,
  type UsDatasetReceivingStores,
} from "./us-dataset-receiving-verify.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import {
  datasetTransformationError,
  makeUsDatasetReceivingIdentity,
  parseUsDatasetTransformationResult,
  usDatasetTransformationRecordIds,
} from "./us-dataset-transformation-contract.js";
import { verifyUsDatasetShippingOriginStatusCore } from "./us-dataset-shipping-origin-status.js";
import type { UsDatasetVerifiedOrigin } from "./us-dataset-shipping-projection.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";
import type { UsDatasetTransformationDependencies } from "./us-dataset-terminal-read-contract.js";

export type UsDatasetTransformationStores = UsDatasetReceivingStores &
  Readonly<{ transformation: UsTransformationStore }>;

/** Internal fresh mode is only for newly private native writes in this transaction.
 * Replay must acquire both public roots before any inbound lot or catalogue lock. */
export async function verifyUsDatasetTransformation(
  ...args: Parameters<typeof verifyUsDatasetTransformationOrigin>
): Promise<void> {
  await verifyUsDatasetTransformationOrigin(...args);
}

export async function verifyUsDatasetTransformationOrigin(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  stores: UsDatasetTransformationStores,
  mode: "fresh" | "replay",
): Promise<UsDatasetVerifiedOrigin> {
  return verifyUsDatasetTransformationOriginCore(
    tx,
    context,
    rawIntent,
    rawReceipt,
    freshUsDatasetTerminalDependencies(stores),
    mode,
  );
}

export async function verifyUsDatasetTransformationOriginCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  stores: UsDatasetTransformationDependencies,
  mode: "fresh" | "replay",
): Promise<UsDatasetVerifiedOrigin> {
  const intent = parseUsDatasetIntent(rawIntent);
  const receipt = parseUsDemoReceipt(rawReceipt);
  const result = parseUsDatasetTransformationResult(receipt.result);
  const mismatch = (cause?: unknown) =>
    datasetTransformationError("us_dataset_transformation_mismatch", intent.unitKey, cause);
  const equal = (a: unknown, b: unknown) => {
    if (!canonicalExportEqual(a, b)) throw mismatch();
  };
  equal(intent.stage, "transformation");
  equal(intent.unitKey, result.input.chain.unitKey);
  equal(intent.input, result.input);
  equal(result.createInput.operationKey, intent.operationKey);
  equal(result.finalizeInput.operationKey, intent.operationKey);
  equal(receipt.recordIds, usDatasetTransformationRecordIds(result));
  equal(receipt.resultDigest, canonicalExportDigest(result));
  const dependency = result.input;
  // Validate BOTH journal dependencies before any business row lock or native getter.
  const [references, receiving] = await stores.journal.readStagesInTransaction(
    tx,
    context,
    dependency.references.datasetId,
    [
      { unitKey: "references", stage: "references" },
      { unitKey: dependency.receiving.unitKey, stage: "receiving" },
    ],
  );
  if (!references?.receipt || !receiving?.receipt) throw mismatch();
  equal(
    makeUsDatasetReferenceIdentity(dependency.references.datasetId, references),
    dependency.references,
  );
  equal(
    makeUsDatasetReceivingIdentity(dependency.receiving.datasetId, receiving),
    dependency.receiving,
  );
  const upstream = parseUsDatasetReceivingResult(receiving.receipt.result);
  equal(upstream.input.references, dependency.references);
  equal(
    result.inputLots,
    upstream.lots.map((lot, i) => ({ lineNo: i + 1, lotId: lot.id })),
  );
  const bindings = parseUsDatasetReferenceResult(references.receipt.result).bindings;
  try {
    await stores.locks.transformation(tx, context, {
      receiving: upstream,
      transformation: mode === "replay" ? result : null,
    });
    const verifiedReceiving = await verifyUsDatasetReceivingResultCore(
      tx,
      context,
      receiving.intent,
      receiving.receipt,
      stores,
    );
    await verifyUsDatasetTransformationContentCore(
      tx,
      context,
      intent,
      result,
      bindings,
      upstream.lots,
      stores,
      (current) => verifyUsDatasetShippingOriginStatusCore(tx, context, stores, result, current),
      mismatch,
    );
    return { receiving: verifiedReceiving, transformation: result };
  } catch (error) {
    if (
      error instanceof NotFoundException ||
      error instanceof ServiceUnavailableException ||
      (error instanceof Error &&
        (error.name === "ZodError" ||
          ["us_dataset_receiving_mismatch", "us_dataset_reference_mismatch"].includes(
            error.message,
          )))
    )
      throw mismatch(error);
    throw error;
  }
}
