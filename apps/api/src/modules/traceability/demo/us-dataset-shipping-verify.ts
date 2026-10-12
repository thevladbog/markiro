import { verifyUsDatasetShippingContent } from "./us-dataset-shipping-verify-content.js";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import {
  parseUsDatasetIntent,
  type UsDatasetContext,
  type UsDatasetIntent,
  type UsDatasetReceipt,
} from "./us-dataset-contract.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  datasetShippingError,
  makeUsDatasetShippingPlan,
  parseUsDatasetShippingResult,
  usDatasetShippingOperationKey,
  usDatasetShippingRecordIds,
} from "./us-dataset-shipping-contract.js";
import {
  prepareUsDatasetShipping,
  type UsDatasetShippingStores,
} from "./us-dataset-shipping-prepare.js";
import { parseUsDatasetTransformationResult } from "./us-dataset-transformation-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";

export async function verifyUsDatasetShipping(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  stores: UsDatasetShippingStores,
  mode: "fresh" | "replay",
): Promise<void> {
  const header = await stores.journal.readHeaderInTransaction(tx, context);
  if (!header) throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", "unknown");
  const intent = parseUsDatasetIntent(rawIntent),
    receipt = parseUsDemoReceipt(rawReceipt);
  const fail = () => datasetShippingError("us_dataset_shipping_mismatch", intent.unitKey);
  const equal = (a: unknown, b: unknown) => {
    if (canonicalExportDigest(a) !== canonicalExportDigest(b)) throw fail();
  };
  const result = parseUsDatasetShippingResult(receipt.result);
  const prepared = await prepareUsDatasetShipping(
    tx,
    context,
    header.id,
    intent.unitKey,
    "verification",
    stores,
  );
  equal(intent, prepared.intent);
  equal(intent.stage, "shipping");
  equal(result.input, prepared.input);
  equal(receipt.resultDigest, canonicalExportDigest(result));
  equal(receipt.recordIds, usDatasetShippingRecordIds(result));
  if (mode === "fresh") {
    if (prepared.shipping.receipt || prepared.shipping.revision !== 1) throw fail();
  } else {
    if (!prepared.shipping.receipt) throw fail();
    equal(receipt, prepared.shipping.receipt);
  }
  equal(
    result.originLot,
    parseUsDatasetTransformationResult(prepared.transformation.receipt?.result).outputLot,
  );
  equal(
    await stores.lots.getLotInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      result.input.outputLotId,
    ),
    result.outputLotAfter,
  );
  const plan = makeUsDatasetShippingPlan(result.input);
  const bindings = parseUsDatasetReferenceResult(prepared.references.receipt?.result).bindings;
  await verifyUsDatasetShippingContent(
    tx,
    context,
    intent,
    {
      chain: result.input.chain,
      outputLotId: result.input.outputLotId,
      outputProductId: result.input.outputProductId,
      plan,
      originLot: result.originLot,
      outputLotAfter: result.outputLotAfter,
      shipments: result.shipments,
      operationKeyForShipment: usDatasetShippingOperationKey,
    },
    bindings,
    mode,
    stores,
    fail,
  );
}
