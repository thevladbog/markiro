import { canonicalExportDigest } from "@markiro/domain";
import {
  platformUuidSchema,
  referenceDocumentSchema,
  traceabilityLotSchema,
  createShippingDraftSchema,
  finalizeShippingSchema,
  shippingDraftRecordSchema,
  shippingFinalizedRecordSchema,
  type TraceabilityLot,
} from "@markiro/platform-contracts";
import { z } from "zod";
import {
  parseUsDatasetCorrectedShippingInput,
  makeUsDatasetCorrectedShippingPlan,
  type UsDatasetCorrectedShippingInput,
} from "./us-dataset-corrected-shipping-contract.js";
import {
  usDatasetShippingOperationKey,
  type UsDatasetShippingShipmentResult,
} from "./us-dataset-shipping-contract.js";
import { assertUsDatasetCorrectedTransformationJson } from "./us-dataset-corrected-transformation-contract.js";
import { checkUsDatasetShippingResultContent } from "./us-dataset-shipping-result-content.js";

export type UsDatasetCorrectedShippingResult = Readonly<{
  input: UsDatasetCorrectedShippingInput;
  originLot: TraceabilityLot;
  outputLotAfter: TraceabilityLot;
  shipments: readonly UsDatasetShippingShipmentResult[];
}>;

type ErrorCode =
  | "us_dataset_corrected_shipping_result_invalid"
  | "us_dataset_corrected_shipping_conflict"
  | "us_dataset_corrected_shipping_mismatch"
  | "us_dataset_corrected_shipping_prerequisite_incomplete";

export function datasetCorrectedShippingError(
  code: ErrorCode,
  cause?: unknown,
): Error & { unitKey: "correction_0001"; stage: "shipping" } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), {
    unitKey: "correction_0001" as const,
    stage: "shipping" as const,
  });
}

const uuid = platformUuidSchema.refine((value) => /^[0-9a-f-]+$/.test(value));
const shipmentSchema = z
  .object({
    shipmentNo: z.literal(1),
    operationKey: uuid,
    requestId: z.string().max(100),
    documents: z
      .array(z.object({ key: z.string(), record: referenceDocumentSchema }).strict())
      .length(2),
    createInput: createShippingDraftSchema,
    finalizeInput: finalizeShippingSchema,
    created: shippingDraftRecordSchema,
    finalized: shippingFinalizedRecordSchema,
  })
  .strict();
const schema = z
  .object({
    input: z.unknown(),
    originLot: traceabilityLotSchema,
    outputLotAfter: traceabilityLotSchema,
    shipments: z.array(shipmentSchema).length(1),
  })
  .strict();

/** Traverse only an owned copy after complete descriptor-safe validation. */
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Frozen native evidence; current ownership and balance require the executor/verifier. */
export function parseUsDatasetCorrectedShippingResult(
  raw: unknown,
): UsDatasetCorrectedShippingResult {
  try {
    assertUsDatasetCorrectedTransformationJson(raw);
    const parsed = schema.parse(raw);
    const input = parseUsDatasetCorrectedShippingInput(parsed.input);
    const result = { ...parsed, input };
    if (canonicalExportDigest(raw) !== canonicalExportDigest(result)) {
      throw new Error("us_dataset_corrected_shipping_evidence_invalid");
    }
    checkUsDatasetShippingResultContent({
      chain: input.chain,
      outputLotId: input.casesInput.outputLotId,
      outputProductId: input.casesInput.outputProductId,
      plan: makeUsDatasetCorrectedShippingPlan(input),
      originLot: result.originLot,
      outputLotAfter: result.outputLotAfter,
      shipments: result.shipments,
      operationKeyForShipment: usDatasetShippingOperationKey,
    });
    return freezeOwned(structuredClone(result));
  } catch (cause) {
    throw datasetCorrectedShippingError("us_dataset_corrected_shipping_result_invalid", cause);
  }
}

export function usDatasetCorrectedShippingRecordIds(
  result: UsDatasetCorrectedShippingResult,
): readonly string[] {
  const parsed = parseUsDatasetCorrectedShippingResult(result);
  return Object.freeze(
    parsed.shipments.flatMap((shipment) => [
      ...shipment.documents.map(({ record }) => record.id),
      shipment.created.id,
    ]),
  );
}
