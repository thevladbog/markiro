import { canonicalExportDigest, isValidSscc } from "@markiro/domain";
import { platformUuidSchema } from "@markiro/platform-contracts";
import { z } from "zod";
import type { UsDatasetCasesSupportInput } from "./us-dataset-cases-contract.js";
import { parseUsDatasetIntent } from "./us-dataset-contract.js";
import {
  assertUsDatasetCorrectedTransformationJson,
  makeUsDatasetCorrectedTransformationInput,
  parseUsDatasetCorrectedTransformationInput,
  type UsDatasetCorrectedTransformationInput,
} from "./us-dataset-corrected-transformation-contract.js";
import {
  parseUsDatasetCorrectedTransformationResult,
  usDatasetCorrectedTransformationRecordIds,
} from "./us-dataset-corrected-transformation-result.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import { makeUsSixMonthSpecialExamples, usSixMonthDefinition } from "./us-six-month-definition.js";

export type UsDatasetCorrectedCasesInput = Readonly<{
  codec: "us-dataset-corrected-cases-input-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  references: UsDatasetCorrectedTransformationInput["references"];
  amendment: UsDatasetCorrectedTransformationInput["amendment"];
  receivingOrigin: UsDatasetCorrectedTransformationInput["receivingOrigin"];
  transformation: Readonly<{
    datasetId: string;
    unitKey: "correction_0001";
    stage: "transformation";
    revision: 2;
    operationKey: string;
    inputDigest: string;
    resultDigest: string;
  }>;
  transformationOrigin: Readonly<{
    rootId: string;
    eventId: string;
    revision: 1;
    lifecycleVersion: 2;
  }>;
  outputLotId: string;
  outputProductId: string;
  support: UsDatasetCasesSupportInput;
}>;
type ErrorCode =
  | "us_dataset_corrected_cases_input_invalid"
  | "us_dataset_corrected_cases_prerequisite_incomplete"
  | "us_dataset_corrected_cases_dependency_conflict";
function casesError(code: ErrorCode, cause: unknown): Error {
  return Object.assign(new Error(code, { cause }), { unitKey: "correction_0001", stage: "cases" });
}
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .pipe(platformUuidSchema);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  });
const supportSchema = z
  .object({
    capturedAt: instant,
    shiftId: uuid,
    numberMonthKey: z.string().regex(/^[A-Z]{3}\d{2}$/),
    numberSeq: z.literal(261),
    boxes: z
      .array(
        z
          .object({
            id: uuid,
            deviceBoxId: z
              .string()
              .min(1)
              .refine((value) => value.trim() === value),
            sscc: z
              .string()
              .regex(/^\d{18}$/)
              .refine(isValidSscc),
          })
          .strict(),
      )
      .length(60),
  })
  .strict();
const transformationIdentitySchema = z
  .object({
    datasetId: uuid,
    unitKey: z.literal("correction_0001"),
    stage: z.literal("transformation"),
    revision: z.literal(2),
    operationKey: uuid,
    inputDigest: digest,
    resultDigest: digest,
  })
  .strict();
const inputSchema = z
  .object({
    codec: z.literal("us-dataset-corrected-cases-input-v1"),
    version: z.literal("us-processor-six-month-v1"),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    references: z.unknown(),
    amendment: z.unknown(),
    receivingOrigin: z.unknown(),
    transformation: transformationIdentitySchema,
    transformationOrigin: z
      .object({
        rootId: uuid,
        eventId: uuid,
        revision: z.literal(1),
        lifecycleVersion: z.literal(2),
      })
      .strict(),
    outputLotId: uuid,
    outputProductId: uuid,
    support: supportSchema,
  })
  .strict();
const stageSchema = z
  .object({
    unitKey: z.literal("correction_0001"),
    stage: z.literal("transformation"),
    revision: z.union([z.literal(1), z.literal(2)]),
    intent: z.unknown(),
    receipt: z.unknown().nullable(),
  })
  .strict();
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_corrected_cases_evidence_invalid");
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalExportDigest(a) === canonicalExportDigest(b);
}
/** Traverses only module-owned copies after descriptor-safe validation. */
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}
function supportIds(input: UsDatasetCorrectedCasesInput): readonly string[] {
  return [input.support.shiftId, ...input.support.boxes.map(({ id }) => id)];
}

/** Stored coherence only; future execution must prove current ownership and hold locks. */
export function parseUsDatasetCorrectedCasesInput(raw: unknown): UsDatasetCorrectedCasesInput {
  try {
    assertUsDatasetCorrectedTransformationJson(raw);
    const parsed = inputSchema.parse(raw);
    const upstream = parseUsDatasetCorrectedTransformationInput({
      codec: "us-dataset-corrected-transformation-input-v1",
      version: parsed.version,
      definitionDigest: parsed.definitionDigest,
      references: parsed.references,
      amendment: parsed.amendment,
      receivingOrigin: parsed.receivingOrigin,
      chain: makeUsSixMonthSpecialExamples().correction.correctedChain,
    });
    const input: UsDatasetCorrectedCasesInput = {
      ...parsed,
      references: upstream.references,
      amendment: upstream.amendment,
      receivingOrigin: upstream.receivingOrigin,
    };
    valid(equal(raw, input));
    valid(input.transformation.datasetId === upstream.references.datasetId);
    valid(input.transformationOrigin.rootId === input.transformationOrigin.eventId);
    const priorIds = [
      upstream.receivingOrigin.rootId,
      upstream.receivingOrigin.eventId,
      ...upstream.receivingOrigin.inputLots.map(({ lotId }) => lotId),
    ];
    const nativeIds = [input.transformationOrigin.rootId, input.outputLotId];
    valid(new Set([...priorIds, ...nativeIds]).size === priorIds.length + nativeIds.length);
    const ownedIds = supportIds(input);
    const knownIds = new Set([
      ...priorIds,
      ...nativeIds,
      input.outputProductId,
      upstream.references.datasetId,
    ]);
    valid(new Set(ownedIds).size === ownedIds.length);
    valid(ownedIds.every((id) => !knownIds.has(id)));
    valid(new Set(input.support.boxes.map(({ deviceBoxId }) => deviceBoxId)).size === 60);
    valid(
      equal(
        input.support.boxes.map(({ sscc }) => sscc),
        upstream.chain.cases,
      ),
    );
    const captured = new Date(input.support.capturedAt);
    const month = [
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC",
    ][captured.getUTCMonth()];
    valid(
      input.support.numberMonthKey ===
        `${month}${String(captured.getUTCFullYear() % 100).padStart(2, "0")}`,
    );
    return freezeOwned(structuredClone(input));
  } catch (cause) {
    throw casesError("us_dataset_corrected_cases_input_invalid", cause);
  }
}

/** Binds saved prerequisite evidence, never database authorization or current-row ownership. */
export function makeUsDatasetCorrectedCasesInput(
  references: unknown,
  amendmentStage: unknown,
  transformationStage: unknown,
  support: unknown,
): UsDatasetCorrectedCasesInput {
  let incomplete = false;
  try {
    assertUsDatasetCorrectedTransformationJson({
      references,
      amendmentStage,
      transformationStage,
      support,
    });
    let upstream: UsDatasetCorrectedTransformationInput;
    try {
      upstream = makeUsDatasetCorrectedTransformationInput(references, amendmentStage);
    } catch (cause) {
      incomplete =
        cause instanceof Error &&
        cause.message === "us_dataset_corrected_transformation_prerequisite_incomplete";
      throw cause;
    }
    const row = stageSchema.parse(transformationStage);
    valid(equal(row, transformationStage));
    const intent = parseUsDatasetIntent(row.intent);
    const intentInput = parseUsDatasetCorrectedTransformationInput(intent.input);
    valid(intent.unitKey === row.unitKey && intent.stage === row.stage);
    valid(equal(intentInput, upstream));
    if (row.revision === 1 && row.receipt === null) {
      incomplete = true;
      throw new Error("us_dataset_corrected_cases_pending_transformation");
    }
    valid(row.revision === 2 && row.receipt !== null);
    const receipt = parseUsDemoReceipt(row.receipt);
    const result = parseUsDatasetCorrectedTransformationResult(receipt.result);
    valid(equal(result.input, upstream));
    valid(intent.operationKey === result.createInput.operationKey);
    valid(equal(receipt.recordIds, usDatasetCorrectedTransformationRecordIds(result)));
    const origin = result.finalized.lifecycle;
    valid(origin !== undefined);
    const input = parseUsDatasetCorrectedCasesInput({
      codec: "us-dataset-corrected-cases-input-v1",
      version: upstream.version,
      definitionDigest: upstream.definitionDigest,
      references: upstream.references,
      amendment: upstream.amendment,
      receivingOrigin: upstream.receivingOrigin,
      transformation: {
        datasetId: upstream.references.datasetId,
        unitKey: row.unitKey,
        stage: row.stage,
        revision: row.revision,
        operationKey: intent.operationKey,
        inputDigest: intent.inputDigest,
        resultDigest: receipt.resultDigest,
      },
      transformationOrigin: {
        rootId: origin.rootId,
        eventId: result.finalized.id,
        revision: result.finalized.revision,
        lifecycleVersion: origin.lifecycleVersion,
      },
      outputLotId: result.outputLot.id,
      outputProductId: result.outputLot.productId,
      support,
    });
    const receiptIds = new Set(receipt.recordIds);
    valid(supportIds(input).every((id) => !receiptIds.has(id)));
    return input;
  } catch (cause) {
    throw casesError(
      incomplete
        ? "us_dataset_corrected_cases_prerequisite_incomplete"
        : "us_dataset_corrected_cases_dependency_conflict",
      cause,
    );
  }
}
