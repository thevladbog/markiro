import { canonicalExportDigest, canonicalExportEqual } from "./us-demo-canonical.js";

import {
  platformUuidSchema,
  referenceDocumentSchema,
  traceabilityLotSchema,
  createShippingDraftSchema,
  finalizeShippingSchema,
  shippingDraftRecordSchema,
  shippingFinalizedRecordSchema,
  type ReferenceDocument,
  type TraceabilityLot,
  type CreateShippingDraftInput,
  type FinalizeShippingInput,
  type ShippingDraftRecord,
  type ShippingFinalizedRecord,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { checkUsDatasetShippingResultContent } from "./us-dataset-shipping-result-content.js";
import type { UsDatasetTransformationIdentity } from "./us-dataset-cases-contract.js";
import type { UsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import type { UsDatasetReceivingIdentity } from "./us-dataset-transformation-contract.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import { makeUsSixMonthRegularChain, type UsSixMonthChain } from "./us-six-month-chains.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

export type UsDatasetShippingInput = Readonly<{
  codec: "us-dataset-shipping-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  index: number;
  references: UsDatasetReferenceIdentity;
  receiving: UsDatasetReceivingIdentity;
  transformation: UsDatasetTransformationIdentity;
  outputLotId: string;
  outputProductId: string;
  chain: UsSixMonthChain;
}>;
export type UsDatasetShippingPlanRow = Readonly<{
  shipmentNo: number;
  eventDate: string;
  quantity: string;
  unitOfMeasure: "case";
  shippingLocationKey: string;
  recipientLocationKey: string;
  references: readonly string[];
  outputLotId: string;
  outputProductId: string;
  plannedAvailableBefore: string;
  plannedRemainingAfter: string;
}>;
export type UsDatasetShippingErrorCode =
  | "us_dataset_shipping_input_invalid"
  | "us_dataset_shipping_dependency_conflict"
  | "us_dataset_shipping_result_invalid"
  | "us_dataset_shipping_prerequisite_incomplete"
  | "us_dataset_shipping_conflict"
  | "us_dataset_shipping_mismatch";

export type UsDatasetShippingShipmentResult = Readonly<{
  shipmentNo: number;
  operationKey: string;
  requestId: string;
  documents: readonly Readonly<{ key: string; record: ReferenceDocument }>[];
  createInput: CreateShippingDraftInput;
  finalizeInput: FinalizeShippingInput;
  created: ShippingDraftRecord;
  finalized: ShippingFinalizedRecord;
}>;
export type UsDatasetShippingResult = Readonly<{
  input: UsDatasetShippingInput;
  originLot: TraceabilityLot;
  outputLotAfter: TraceabilityLot;
  shipments: readonly UsDatasetShippingShipmentResult[];
}>;

export function datasetShippingError(
  code: UsDatasetShippingErrorCode,
  unitKey: string,
  cause?: unknown,
): Error & { unitKey: string; stage: "shipping" } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), {
    unitKey,
    stage: "shipping" as const,
  });
}

function shippingError(
  code: UsDatasetShippingErrorCode,
  unitKey: string,
  cause: unknown,
): Error & { unitKey: string; stage: "shipping" } {
  return Object.assign(new Error(code, { cause }), {
    unitKey,
    stage: "shipping" as const,
  });
}

const uuid = platformUuidSchema.refine((value) => /^[0-9a-f-]+$/.test(value));
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const indexSchema = z
  .number()
  .int()
  .min(0)
  .max(259)
  .refine((value) => !Object.is(value, -0));
const referenceIdentitySchema = z
  .object({
    datasetId: uuid,
    unitKey: z.literal("references"),
    stage: z.literal("references"),
    revision: z.literal(2),
    operationKey: uuid,
    inputDigest: digest,
    resultDigest: digest,
  })
  .strict();
const receivingIdentitySchema = referenceIdentitySchema
  .extend({
    unitKey: z.string().regex(/^chain_\d{4}$/),
    stage: z.literal("receiving"),
  })
  .strict();
const transformationIdentitySchema = receivingIdentitySchema
  .extend({
    stage: z.literal("transformation"),
  })
  .strict();
const inputSchema = z
  .object({
    codec: z.literal("us-dataset-shipping-v1"),
    version: z.literal("us-processor-six-month-v1"),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    index: indexSchema,
    references: referenceIdentitySchema,
    receiving: receivingIdentitySchema,
    transformation: transformationIdentitySchema,
    outputLotId: uuid,
    outputProductId: uuid,
    chain: z.custom<UsSixMonthChain>(),
  })
  .strict();
const shipmentResultSchema = z
  .object({
    shipmentNo: z.number().int().min(1).max(2),
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
const resultSchema = z
  .object({
    input: inputSchema,
    originLot: traceabilityLotSchema,
    outputLotAfter: traceabilityLotSchema,
    shipments: z.array(shipmentResultSchema).min(1).max(2),
  })
  .strict();

function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_shipping_evidence_invalid");
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalExportEqual(a, b);
}
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Complete descriptor/size validation before field reads, including diagnostic context. */
function safeRaw(raw: unknown): asserts raw is Record<string, unknown> {
  assertBoundedSyntheticJson(raw);
  const arrayPrototypes = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) valid(Object.getPrototypeOf(value) === Array.prototype);
    for (const child of Object.values(value)) arrayPrototypes(child);
  };
  arrayPrototypes(raw);
}

/** Captured identities and output IDs express intent, not DB ownership or authorization. */
export function makeUsDatasetShippingInput(
  index: number,
  references: UsDatasetReferenceIdentity,
  receiving: UsDatasetReceivingIdentity,
  transformation: UsDatasetTransformationIdentity,
  outputLotId: string,
  outputProductId: string,
): UsDatasetShippingInput {
  let chain: UsSixMonthChain;
  try {
    indexSchema.parse(index);
    chain = makeUsSixMonthRegularChain(index);
  } catch (cause) {
    throw shippingError("us_dataset_shipping_input_invalid", "unknown", cause);
  }
  return parseUsDatasetShippingInput({
    codec: "us-dataset-shipping-v1",
    version: usSixMonthDefinition.version,
    definitionDigest: usSixMonthDefinition.digest,
    index,
    references,
    receiving,
    transformation,
    outputLotId,
    outputProductId,
    chain,
  });
}

export function parseUsDatasetShippingInput(raw: unknown): UsDatasetShippingInput {
  let unitKey = "unknown";
  let code: UsDatasetShippingErrorCode = "us_dataset_shipping_input_invalid";
  try {
    safeRaw(raw);
    const index = indexSchema.safeParse(raw.index);
    if (index.success) unitKey = `chain_${String(index.data).padStart(4, "0")}`;
    const parsed = inputSchema.parse(raw);
    valid(equal(raw, parsed));
    valid(equal(parsed.chain, makeUsSixMonthRegularChain(parsed.index)));
    code = "us_dataset_shipping_dependency_conflict";
    valid(
      parsed.receiving.datasetId === parsed.references.datasetId &&
        parsed.transformation.datasetId === parsed.references.datasetId &&
        parsed.receiving.unitKey === unitKey &&
        parsed.transformation.unitKey === unitKey,
    );
    return freezeOwned(structuredClone(parsed));
  } catch (cause) {
    throw shippingError(code, unitKey, cause);
  }
}

/** Ordered recipe forecasts only: neither current nor historical database balances. */
export function makeUsDatasetShippingPlan(
  input: UsDatasetShippingInput,
): readonly UsDatasetShippingPlanRow[] {
  const parsed = parseUsDatasetShippingInput(input);
  let available = BigInt(parsed.chain.transformation.output.quantity);
  const plan = parsed.chain.shipping.map((shipment, position): UsDatasetShippingPlanRow => {
    const before = available;
    available -= BigInt(shipment.quantity);
    return {
      shipmentNo: position + 1,
      eventDate: shipment.eventDate,
      quantity: shipment.quantity,
      unitOfMeasure: shipment.unitOfMeasure,
      shippingLocationKey: shipment.shippingLocationKey,
      recipientLocationKey: shipment.recipientLocationKey,
      references: [...shipment.references],
      outputLotId: parsed.outputLotId,
      outputProductId: parsed.outputProductId,
      plannedAvailableBefore: String(before),
      plannedRemainingAfter: String(available),
    };
  });
  return freezeOwned(plan);
}

/** One journal UUID owns the chain; native create/finalize command namespaces share this UUID. */
export function usDatasetShippingOperationKey(operationKey: string, shipmentNo: number): string {
  valid(uuid.parse(operationKey) === operationKey);
  valid(shipmentNo === 1 || shipmentNo === 2);
  const hex = canonicalExportDigest({
    namespace: "us-dataset-shipping-operation-v1",
    operationKey,
    shipmentNo,
  })
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Frozen native evidence only; actual ownership and current rows require the verifier. */
export function parseUsDatasetShippingResult(raw: unknown): UsDatasetShippingResult {
  let unitKey = "unknown";
  try {
    safeRaw(raw);
    const input = parseUsDatasetShippingInput(raw.input);
    unitKey = input.chain.unitKey;
    const result = { ...resultSchema.parse(raw), input };
    valid(equal(raw, result));
    checkUsDatasetShippingResultContent({
      chain: input.chain,
      outputLotId: input.outputLotId,
      outputProductId: input.outputProductId,
      plan: makeUsDatasetShippingPlan(input),
      originLot: result.originLot,
      outputLotAfter: result.outputLotAfter,
      shipments: result.shipments,
      operationKeyForShipment: usDatasetShippingOperationKey,
    });
    return freezeOwned(structuredClone(result));
  } catch (cause) {
    throw datasetShippingError("us_dataset_shipping_result_invalid", unitKey, cause);
  }
}

export function usDatasetShippingRecordIds(result: UsDatasetShippingResult): readonly string[] {
  const parsed = parseUsDatasetShippingResult(result);
  return Object.freeze(
    parsed.shipments.flatMap((shipment) => [
      ...shipment.documents.map(({ record }) => record.id),
      shipment.created.id,
    ]),
  );
}
