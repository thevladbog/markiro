import { canonicalExportDigest } from "@markiro/domain";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import {
  parseUsDatasetIntent,
  type UsDatasetContext,
  type UsDatasetIntent,
  type UsDatasetReceipt,
} from "./us-dataset-contract.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  authorizeUsDatasetCorrectedShipping,
  prepareUsDatasetCorrectedShipping,
} from "./us-dataset-corrected-shipping-prepare.js";
import {
  datasetCorrectedShippingError,
  parseUsDatasetCorrectedShippingResult,
  usDatasetCorrectedShippingRecordIds,
} from "./us-dataset-corrected-shipping-result.js";
import { makeUsDatasetCorrectedShippingPlan } from "./us-dataset-corrected-shipping-contract.js";
import { usDatasetShippingOperationKey } from "./us-dataset-shipping-contract.js";
import type { UsDatasetShippingStores } from "./us-dataset-shipping-prepare.js";
import { verifyUsDatasetShippingContent } from "./us-dataset-shipping-verify-content.js";

export async function verifyUsDatasetCorrectedShipping(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  stores: UsDatasetShippingStores,
  mode: "fresh" | "replay",
): Promise<void> {
  await authorizeUsDatasetCorrectedShipping(tx, context, stores);
  const fail = (cause?: unknown) =>
    datasetCorrectedShippingError("us_dataset_corrected_shipping_mismatch", cause);
  const equal = (a: unknown, b: unknown) => {
    if (canonicalExportDigest(a) !== canonicalExportDigest(b)) throw fail();
  };
  try {
    const intent = parseUsDatasetIntent(rawIntent),
      receipt = parseUsDemoReceipt(rawReceipt),
      result = parseUsDatasetCorrectedShippingResult(receipt.result);
    const prepared = await prepareUsDatasetCorrectedShipping(
      tx,
      context,
      intent,
      { mode, receipt },
      stores,
    );
    equal(result.input, prepared.input);
    equal(receipt.resultDigest, canonicalExportDigest(result));
    equal(receipt.recordIds, usDatasetCorrectedShippingRecordIds(result));
    equal(result.originLot, prepared.origin.outputLot);
    equal(
      await stores.lots.getLotInTransaction(
        tx,
        context.tenantId,
        context.actorUserId,
        prepared.input.casesInput.outputLotId,
      ),
      result.outputLotAfter,
    );
    await verifyUsDatasetShippingContent(
      tx,
      context,
      intent,
      {
        chain: result.input.chain,
        outputLotId: result.input.casesInput.outputLotId,
        outputProductId: result.input.casesInput.outputProductId,
        plan: makeUsDatasetCorrectedShippingPlan(result.input),
        originLot: result.originLot,
        outputLotAfter: result.outputLotAfter,
        shipments: result.shipments,
        operationKeyForShipment: usDatasetShippingOperationKey,
      },
      prepared.bindings,
      mode,
      stores,
      fail,
    );
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.message.startsWith("us_dataset_") || cause.name === "ZodError")
    )
      throw fail(cause);
    throw cause;
  }
}
