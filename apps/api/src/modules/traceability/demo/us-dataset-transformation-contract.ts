import { canonicalExportEqual } from "./us-demo-canonical.js";

import {
  platformUuidSchema,
  type ReferenceDocument,
  type TraceabilityLot,
  type CreateTransformationDraftInput,
  type FinalizeTransformationInput,
  type TransformationDraftRecord,
  type TransformationFinalizedRecord,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { parseUsDatasetIntent, type UsDatasetStageRow } from "./us-dataset-contract.js";
import {
  parseUsDatasetReceivingResult,
  usDatasetReceivingRecordIds,
  type UsDatasetReferenceIdentity,
} from "./us-dataset-receiving-contract.js";
import { assertBoundedSyntheticJson, parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import { makeUsSixMonthRegularChain, type UsSixMonthChain } from "./us-six-month-chains.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

import {
  checkUsDatasetTransformationEvidence,
  usDatasetTransformationEvidenceFields,
  usDatasetTransformationEvidenceRecordIds,
} from "./us-dataset-transformation-content.js";
export { US_DATASET_TRANSFORMATION_METADATA } from "./us-dataset-transformation-content.js";
export type UsDatasetReceivingIdentity = Readonly<{
  datasetId: string;
  unitKey: string;
  stage: "receiving";
  revision: 2;
  operationKey: string;
  inputDigest: string;
  resultDigest: string;
}>;
export type UsDatasetTransformationErrorCode =
  | "us_dataset_transformation_input_invalid"
  | "us_dataset_transformation_result_invalid"
  | "us_dataset_transformation_prerequisite_incomplete"
  | "us_dataset_transformation_dependency_conflict"
  | "us_dataset_transformation_conflict"
  | "us_dataset_transformation_mismatch";
export type UsDatasetTransformationInput = Readonly<{
  codec: "us-dataset-transformation-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  references: UsDatasetReferenceIdentity;
  receiving: UsDatasetReceivingIdentity;
  chain: UsSixMonthChain;
}>;
export type UsDatasetTransformationResult = Readonly<{
  input: UsDatasetTransformationInput;
  documents: readonly Readonly<{ key: string; record: ReferenceDocument }>[];
  createInput: CreateTransformationDraftInput;
  finalizeInput: FinalizeTransformationInput;
  created: TransformationDraftRecord;
  finalized: TransformationFinalizedRecord;
  outputLot: TraceabilityLot;
  inputLots: readonly Readonly<{ lineNo: number; lotId: string }>[];
}>;
export function datasetTransformationError(
  code: UsDatasetTransformationErrorCode,
  unitKey: string,
  cause?: unknown,
): Error & { unitKey: string; stage: "transformation" } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), {
    unitKey,
    stage: "transformation" as const,
  });
}
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const referenceIdentitySchema = z
  .object({
    datasetId: platformUuidSchema,
    unitKey: z.literal("references"),
    stage: z.literal("references"),
    revision: z.literal(2),
    operationKey: platformUuidSchema,
    inputDigest: digest,
    resultDigest: digest,
  })
  .strict();
const receivingIdentitySchema = referenceIdentitySchema
  .extend({ unitKey: z.string().regex(/^chain_\d{4}$/), stage: z.literal("receiving") })
  .strict();
const inputSchema = z
  .object({
    codec: z.literal("us-dataset-transformation-v1"),
    version: z.literal("us-processor-six-month-v1"),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    references: referenceIdentitySchema,
    receiving: receivingIdentitySchema,
    chain: z.custom<UsSixMonthChain>(),
  })
  .strict();
const resultSchema = z
  .object({
    input: inputSchema,
    ...usDatasetTransformationEvidenceFields,
  })
  .strict();
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_transformation_evidence_invalid");
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
/** Do not read even diagnostic properties until the raw root has data descriptors. */
function safeRaw(raw: unknown): asserts raw is Record<string, unknown> {
  valid(raw !== null && typeof raw === "object" && !Array.isArray(raw));
  const prototype: unknown = Object.getPrototypeOf(raw);
  valid(prototype === Object.prototype || prototype === null);
  valid(Reflect.ownKeys(raw).length === Object.keys(raw).length);
  valid(Object.values(Object.getOwnPropertyDescriptors(raw)).every((d) => "value" in d));
  assertBoundedSyntheticJson(raw);
}
export function makeUsDatasetReceivingIdentity(
  datasetId: string,
  stage: UsDatasetStageRow,
): UsDatasetReceivingIdentity {
  let unitKey = "unknown";
  try {
    safeRaw(stage);
    unitKey = stage.unitKey;
    if (stage.revision === 1 || stage.receipt === null)
      throw datasetTransformationError(
        "us_dataset_transformation_prerequisite_incomplete",
        unitKey,
      );
    const intent = parseUsDatasetIntent(stage.intent);
    const receipt = parseUsDemoReceipt(stage.receipt);
    const result = parseUsDatasetReceivingResult(receipt.result);
    valid(
      stage.stage === "receiving" &&
        stage.revision === 2 &&
        stage.unitKey === result.input.chain.unitKey,
    );
    valid(intent.stage === "receiving" && intent.unitKey === stage.unitKey);
    valid(equal(intent.input, result.input));
    valid(intent.operationKey === result.created.operationKey);
    valid(equal(receipt.recordIds, usDatasetReceivingRecordIds(result)));
    valid(result.input.references.datasetId === datasetId);
    return freezeOwned(
      receivingIdentitySchema.parse({
        datasetId,
        unitKey,
        stage: "receiving",
        revision: 2,
        operationKey: intent.operationKey,
        inputDigest: intent.inputDigest,
        resultDigest: receipt.resultDigest,
      }),
    );
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message === "us_dataset_transformation_prerequisite_incomplete"
    )
      throw cause;
    throw datasetTransformationError(
      "us_dataset_transformation_dependency_conflict",
      unitKey,
      cause,
    );
  }
}
export function makeUsDatasetTransformationInput(
  index: number,
  references: UsDatasetReferenceIdentity,
  receiving: UsDatasetReceivingIdentity,
): UsDatasetTransformationInput {
  let unitKey = "unknown";
  try {
    const chain = makeUsSixMonthRegularChain(index);
    unitKey = chain.unitKey;
    safeRaw(references);
    safeRaw(receiving);
    if (receiving.unitKey !== chain.unitKey || receiving.datasetId !== references.datasetId)
      throw datasetTransformationError("us_dataset_transformation_dependency_conflict", unitKey);
    return parseUsDatasetTransformationInput({
      codec: "us-dataset-transformation-v1",
      version: usSixMonthDefinition.version,
      definitionDigest: usSixMonthDefinition.digest,
      references,
      receiving,
      chain,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "us_dataset_transformation_dependency_conflict")
      throw cause;
    throw datasetTransformationError("us_dataset_transformation_input_invalid", unitKey, cause);
  }
}
export function parseUsDatasetTransformationInput(raw: unknown): UsDatasetTransformationInput {
  let unitKey = "unknown";
  try {
    safeRaw(raw);
    const parsed = inputSchema.parse(raw);
    const match = /^chain_(\d{4})$/.exec(parsed.chain?.unitKey);
    valid(match !== null && match[1] !== undefined);
    unitKey = parsed.chain.unitKey;
    valid(equal(parsed.chain, makeUsSixMonthRegularChain(Number(match[1]))));
    valid(
      parsed.receiving.unitKey === unitKey &&
        parsed.receiving.datasetId === parsed.references.datasetId,
    );
    valid(equal(raw, parsed));
    return freezeOwned(structuredClone(parsed));
  } catch (cause) {
    throw datasetTransformationError("us_dataset_transformation_input_invalid", unitKey, cause);
  }
}

export function parseUsDatasetTransformationResult(raw: unknown): UsDatasetTransformationResult {
  let unitKey = "unknown";
  try {
    safeRaw(raw);
    const input = parseUsDatasetTransformationInput(raw["input"]);
    unitKey = input.chain.unitKey;
    const result = { ...resultSchema.parse(raw), input };
    valid(equal(raw, result));
    checkUsDatasetTransformationEvidence(result);
    return freezeOwned(structuredClone(result));
  } catch (cause) {
    throw datasetTransformationError("us_dataset_transformation_result_invalid", unitKey, cause);
  }
}
export function usDatasetTransformationRecordIds(
  result: UsDatasetTransformationResult,
): readonly string[] {
  const parsed = parseUsDatasetTransformationResult(result);
  return usDatasetTransformationEvidenceRecordIds(parsed);
}
