import { canonicalExportEqual, ownedUsDemoJsonCopy } from "./us-demo-canonical.js";

import { platformUuidSchema } from "@markiro/platform-contracts";
import { z } from "zod";
import { parseUsDatasetIntent } from "./us-dataset-contract.js";
import type { UsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import {
  parseUsDatasetSpecialInput,
  parseUsDatasetSpecialResult,
  usDatasetSpecialRecordIds,
} from "./us-dataset-special-contract.js";
import { assertBoundedSyntheticJson, parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import type { UsSixMonthChain } from "./us-six-month-chains.js";
import { makeUsSixMonthSpecialExamples, usSixMonthDefinition } from "./us-six-month-definition.js";

export type UsDatasetCorrectedTransformationInput = Readonly<{
  codec: "us-dataset-corrected-transformation-input-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  references: UsDatasetReferenceIdentity;
  amendment: Readonly<{
    datasetId: string;
    unitKey: "correction_0001";
    stage: "amend_receiving";
    revision: 2;
    operationKey: string;
    inputDigest: string;
    resultDigest: string;
  }>;
  receivingOrigin: Readonly<{
    rootId: string;
    eventId: string;
    revision: 2;
    lifecycleVersion: 4;
    inputLots: readonly Readonly<{ lineNo: 1 | 2; lotId: string }>[];
  }>;
  chain: UsSixMonthChain;
}>;

type ErrorCode =
  | "us_dataset_corrected_transformation_input_invalid"
  | "us_dataset_corrected_transformation_prerequisite_incomplete"
  | "us_dataset_corrected_transformation_dependency_conflict"
  | "us_dataset_corrected_transformation_result_invalid"
  | "us_dataset_corrected_transformation_conflict"
  | "us_dataset_corrected_transformation_mismatch";
export function datasetCorrectedTransformationError(code: ErrorCode, cause?: unknown): Error {
  return Object.assign(new Error(code, { cause }), {
    unitKey: "correction_0001",
    stage: "transformation",
  });
}
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .pipe(platformUuidSchema);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
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
const amendmentIdentitySchema = referenceIdentitySchema
  .extend({ unitKey: z.literal("correction_0001"), stage: z.literal("amend_receiving") })
  .strict();
const inputSchema = z
  .object({
    codec: z.literal("us-dataset-corrected-transformation-input-v1"),
    version: z.literal("us-processor-six-month-v1"),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    references: referenceIdentitySchema,
    amendment: amendmentIdentitySchema,
    receivingOrigin: z
      .object({
        rootId: uuid,
        eventId: uuid,
        revision: z.literal(2),
        lifecycleVersion: z.literal(4),
        inputLots: z.tuple([
          z.object({ lineNo: z.literal(1), lotId: uuid }).strict(),
          z.object({ lineNo: z.literal(2), lotId: uuid }).strict(),
        ]),
      })
      .strict(),
    chain: z.custom<UsSixMonthChain>(),
  })
  .strict();
const amendmentStageSchema = z
  .object({
    unitKey: z.literal("correction_0001"),
    stage: z.literal("amend_receiving"),
    revision: z.union([z.literal(1), z.literal(2)]),
    intent: z.unknown(),
    receipt: z.unknown().nullable(),
  })
  .strict();
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_corrected_transformation_evidence_invalid");
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalExportEqual(a, b);
}

export function assertUsDatasetCorrectedTransformationJson(raw: unknown): void {
  // The shared walker bounds depth/bytes and rejects cycles and own accessors, but it
  // permits exotic array prototypes. Reject those before codecs/digests use iterators.
  assertBoundedSyntheticJson(raw);
  function checkArrays(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) valid(Object.getPrototypeOf(value) === Array.prototype);
    // Read only data descriptor values; never iterate or access properties on caller arrays.
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ("value" in descriptor) checkArrays(descriptor.value);
    }
  }
  checkArrays(raw);
}

/** Internal evidence consistency only; current-row ownership and locks belong to the executor. */
export function parseUsDatasetCorrectedTransformationInput(
  raw: unknown,
): UsDatasetCorrectedTransformationInput {
  try {
    assertUsDatasetCorrectedTransformationJson(raw);
    const input = inputSchema.parse(raw);
    valid(equal(input.chain, makeUsSixMonthSpecialExamples().correction.correctedChain));
    valid(equal(raw, input));
    valid(input.references.datasetId === input.amendment.datasetId);
    valid(input.references.operationKey !== input.amendment.operationKey);
    const origin = input.receivingOrigin;
    const originIds = [
      origin.rootId,
      origin.eventId,
      ...origin.inputLots.map(({ lotId }) => lotId),
    ];
    valid(new Set(originIds).size === originIds.length);
    return ownedUsDemoJsonCopy(input);
  } catch (cause) {
    throw datasetCorrectedTransformationError(
      "us_dataset_corrected_transformation_input_invalid",
      cause,
    );
  }
}

export function makeUsDatasetCorrectedTransformationInput(
  references: unknown,
  amendmentStage: unknown,
): UsDatasetCorrectedTransformationInput {
  let incomplete = false;
  try {
    // Bound the combined caller evidence before reading either half or invoking nested codecs.
    assertUsDatasetCorrectedTransformationJson({ references, amendmentStage });
    const shared = referenceIdentitySchema.parse(references);
    const row = amendmentStageSchema.parse(amendmentStage);
    const intent = parseUsDatasetIntent(row.intent);
    const input = parseUsDatasetSpecialInput(intent.input);
    valid(intent.unitKey === row.unitKey && intent.stage === row.stage);
    valid(input.kind === "correction" && input.stage === "amend_receiving");
    valid(equal(input.references, shared));
    valid(intent.operationKey !== shared.operationKey);
    valid(input.receiving !== null && intent.operationKey !== input.receiving.operationKey);
    if (row.revision === 1 && row.receipt === null) {
      incomplete = true;
      throw new Error("us_dataset_corrected_transformation_pending_amendment");
    }
    valid(row.revision === 2 && row.receipt !== null);
    const receipt = parseUsDemoReceipt(row.receipt);
    const result = parseUsDatasetSpecialResult(receipt.result);
    valid(result.stage === "amend_receiving");
    valid(equal(input, result.input));
    valid(intent.operationKey === result.started.operationKey);
    valid(equal(receipt.recordIds, usDatasetSpecialRecordIds(result)));
    const current = result.finalized.record;
    valid(current.content.kind === "finalized");
    return parseUsDatasetCorrectedTransformationInput({
      codec: "us-dataset-corrected-transformation-input-v1",
      version: usSixMonthDefinition.version,
      definitionDigest: usSixMonthDefinition.digest,
      references: shared,
      amendment: {
        datasetId: shared.datasetId,
        unitKey: row.unitKey,
        stage: row.stage,
        revision: row.revision,
        operationKey: intent.operationKey,
        inputDigest: intent.inputDigest,
        resultDigest: receipt.resultDigest,
      },
      receivingOrigin: {
        rootId: current.lifecycle.rootId,
        eventId: current.id,
        revision: current.revision,
        lifecycleVersion: current.lifecycle.lifecycleVersion,
        inputLots: current.content.snapshot.items.map(({ lineNo, lotId }) => ({ lineNo, lotId })),
      },
      chain: makeUsSixMonthSpecialExamples().correction.correctedChain,
    });
  } catch (cause) {
    throw datasetCorrectedTransformationError(
      incomplete
        ? "us_dataset_corrected_transformation_prerequisite_incomplete"
        : "us_dataset_corrected_transformation_dependency_conflict",
      cause,
    );
  }
}
