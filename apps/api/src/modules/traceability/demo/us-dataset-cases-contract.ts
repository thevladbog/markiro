import { isValidSscc } from "@markiro/domain";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import { platformUuidSchema, type CaseLinkResult } from "@markiro/platform-contracts";
import { z } from "zod";
import {
  checkUsDatasetCasesEvidence,
  usDatasetCasesEvidenceFields,
  type UsDatasetCasesSupportEvidence,
} from "./us-dataset-cases-content.js";
import { parseUsDatasetIntent, type UsDatasetStageRow } from "./us-dataset-contract.js";
import {
  makeUsDatasetReferenceIdentity,
  parseUsDatasetReceivingResult,
  type UsDatasetReferenceIdentity,
} from "./us-dataset-receiving-contract.js";
import {
  makeUsDatasetReceivingIdentity,
  parseUsDatasetTransformationResult,
  usDatasetTransformationRecordIds,
  type UsDatasetReceivingIdentity,
} from "./us-dataset-transformation-contract.js";
import { assertBoundedSyntheticJson, parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import { makeUsSixMonthRegularChain } from "./us-six-month-chains.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

export type { UsDatasetCasesSupportEvidence } from "./us-dataset-cases-content.js";

export type UsDatasetTransformationIdentity = Readonly<{
  datasetId: string;
  unitKey: string;
  stage: "transformation";
  revision: 2;
  operationKey: string;
  inputDigest: string;
  resultDigest: string;
}>;
export type UsDatasetCasesSupportInput = Readonly<{
  capturedAt: string;
  shiftId: string;
  numberMonthKey: string;
  numberSeq: number;
  boxes: readonly Readonly<{ id: string; deviceBoxId: string; sscc: string }>[];
}>;
export type UsDatasetCasesInput = Readonly<{
  codec: "us-dataset-cases-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  index: number;
  references: UsDatasetReferenceIdentity;
  receiving: UsDatasetReceivingIdentity;
  transformation: UsDatasetTransformationIdentity;
  outputLotId: string;
  outputProductId: string;
  support: UsDatasetCasesSupportInput;
}>;
export type UsDatasetCasesResult = Readonly<{
  input: UsDatasetCasesInput;
  support: UsDatasetCasesSupportEvidence;
  operationKey: string;
  requestId: string;
  linked: CaseLinkResult;
}>;
export type UsDatasetCasesErrorCode =
  | "us_dataset_cases_input_invalid"
  | "us_dataset_cases_result_invalid"
  | "us_dataset_cases_prerequisite_incomplete"
  | "us_dataset_cases_dependency_conflict"
  | "us_dataset_cases_conflict"
  | "us_dataset_cases_mismatch";

export function datasetCasesError(
  code: UsDatasetCasesErrorCode,
  unitKey: string,
  cause?: unknown,
): Error & { unitKey: string; stage: "cases" } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), {
    unitKey: /^[a-z][a-z0-9_-]{0,63}$/.test(unitKey) ? unitKey : "unknown",
    stage: "cases" as const,
  });
}
const uuid = platformUuidSchema.refine((value) => /^[0-9a-f-]+$/.test(value));
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const text = z.string().trim().min(1);
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  });
const identitySchema = z
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
const receivingIdentitySchema = identitySchema
  .extend({
    unitKey: z.string().regex(/^chain_\d{4}$/),
    stage: z.literal("receiving"),
  })
  .strict();
const transformationIdentitySchema = receivingIdentitySchema
  .extend({ stage: z.literal("transformation") })
  .strict();
const boxSchema = z
  .object({
    id: uuid,
    deviceBoxId: text,
    sscc: z
      .string()
      .regex(/^\d{18}$/)
      .refine(isValidSscc),
  })
  .strict();
const supportSchema = z
  .object({
    capturedAt: instant,
    shiftId: uuid,
    numberMonthKey: z.string().regex(/^[A-Z]{3}\d{2}$/),
    numberSeq: z.number().int().positive(),
    boxes: z.array(boxSchema).min(1).max(100),
  })
  .strict();
const inputSchema = z
  .object({
    codec: z.literal("us-dataset-cases-v1"),
    version: z.literal("us-processor-six-month-v1"),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    index: z.number().int().min(0).max(259),
    references: identitySchema,
    receiving: receivingIdentitySchema,
    transformation: transformationIdentitySchema,
    outputLotId: uuid,
    outputProductId: uuid,
    support: supportSchema,
  })
  .strict();
const resultSchema = z.object({ input: inputSchema, ...usDatasetCasesEvidenceFields }).strict();
const stageSchema = z
  .object({
    unitKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    stage: z.enum(["references", "receiving", "transformation"]),
    revision: z.number().int().positive(),
    intent: z.custom<UsDatasetStageRow["intent"]>(),
    receipt: z.custom<UsDatasetStageRow["receipt"]>(),
  })
  .strict();
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_cases_evidence_invalid");
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalExportDigest(a) === canonicalExportDigest(b);
}
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}
/** The shared descriptor walker must finish before schemas or diagnostics access raw fields. */
function safeRaw(raw: unknown): void {
  assertBoundedSyntheticJson(raw);
  // Shared JSON validation rejects custom object prototypes; also reject custom array prototypes.
  const prototypes = (value: unknown): void => {
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) valid(Object.getPrototypeOf(value) === Array.prototype);
      for (const child of Object.values(value)) prototypes(child);
    }
  };
  prototypes(raw);
}
function completeStage(raw: UsDatasetStageRow): UsDatasetStageRow {
  safeRaw(raw);
  const stage = stageSchema.parse(raw);
  valid(equal(raw, stage));
  if (stage.revision === 1 || stage.receipt === null)
    throw datasetCasesError("us_dataset_cases_prerequisite_incomplete", stage.unitKey);
  valid(stage.revision === 2);
  return stage;
}
function prerequisiteError(cause: unknown, unitKey: string): never {
  if (cause instanceof Error && cause.message === "us_dataset_cases_prerequisite_incomplete")
    throw cause;
  throw datasetCasesError("us_dataset_cases_dependency_conflict", unitKey, cause);
}
function transformationEvidence(datasetId: string, raw: UsDatasetStageRow) {
  let unitKey = "unknown";
  try {
    const stage = completeStage(raw);
    unitKey = stage.unitKey;
    valid(stage.receipt !== null);
    const intent = parseUsDatasetIntent(stage.intent);
    const receipt = parseUsDemoReceipt(stage.receipt);
    const result = parseUsDatasetTransformationResult(receipt.result);
    valid(stage.stage === "transformation" && stage.unitKey === result.input.chain.unitKey);
    valid(intent.stage === stage.stage && intent.unitKey === stage.unitKey);
    valid(
      equal(intent.input, result.input) && intent.operationKey === result.createInput.operationKey,
    );
    valid(equal(receipt.recordIds, usDatasetTransformationRecordIds(result)));
    valid(
      result.input.references.datasetId === datasetId &&
        result.input.receiving.datasetId === datasetId,
    );
    const identity = transformationIdentitySchema.parse({
      datasetId,
      unitKey,
      stage: "transformation",
      revision: 2,
      operationKey: intent.operationKey,
      inputDigest: intent.inputDigest,
      resultDigest: receipt.resultDigest,
    });
    valid(identity.datasetId === datasetId);
    return { identity: freezeOwned(identity), result };
  } catch (cause) {
    return prerequisiteError(cause, unitKey);
  }
}
export function makeUsDatasetTransformationIdentity(
  datasetId: string,
  stage: UsDatasetStageRow,
): UsDatasetTransformationIdentity {
  return transformationEvidence(datasetId, stage).identity;
}
/** Validates captured upstream evidence, never current DB ownership or authorization. */
export function makeUsDatasetCasesInput(
  index: number,
  datasetId: string,
  references: UsDatasetStageRow,
  receiving: UsDatasetStageRow,
  transformation: UsDatasetStageRow,
  support: UsDatasetCasesSupportInput,
): UsDatasetCasesInput {
  let unitKey = "unknown";
  try {
    unitKey = makeUsSixMonthRegularChain(index).unitKey;
  } catch (cause) {
    throw datasetCasesError("us_dataset_cases_input_invalid", unitKey, cause);
  }
  let referenceIdentity: UsDatasetReferenceIdentity, receivingIdentity: UsDatasetReceivingIdentity;
  let evidence: ReturnType<typeof transformationEvidence>;
  try {
    const referenceStage = completeStage(references),
      receivingStage = completeStage(receiving);
    referenceIdentity = makeUsDatasetReferenceIdentity(datasetId, referenceStage);
    receivingIdentity = makeUsDatasetReceivingIdentity(datasetId, receivingStage);
    evidence = transformationEvidence(datasetId, transformation);
    valid(receivingStage.receipt !== null);
    const receivingResult = parseUsDatasetReceivingResult(
      parseUsDemoReceipt(receivingStage.receipt).result,
    );
    valid(equal(receivingResult.input.references, referenceIdentity));
    valid(equal(evidence.result.input.references, referenceIdentity));
    valid(equal(evidence.result.input.receiving, receivingIdentity));
    valid(receivingIdentity.unitKey === unitKey && evidence.identity.unitKey === unitKey);
    valid(
      equal(
        evidence.result.inputLots.map((row) => row.lotId),
        receivingResult.lots.map((row) => row.id),
      ),
    );
    valid(!receivingResult.lots.some((lot) => lot.id === evidence.result.outputLot.id));
  } catch (cause) {
    return prerequisiteError(cause, unitKey);
  }
  return parseUsDatasetCasesInput({
    codec: "us-dataset-cases-v1",
    version: usSixMonthDefinition.version,
    definitionDigest: usSixMonthDefinition.digest,
    index,
    references: referenceIdentity,
    receiving: receivingIdentity,
    transformation: evidence.identity,
    outputLotId: evidence.result.outputLot.id,
    outputProductId: evidence.result.outputLot.productId,
    support,
  });
}
export function parseUsDatasetCasesInput(raw: unknown): UsDatasetCasesInput {
  let unitKey = "unknown";
  try {
    safeRaw(raw);
    const parsed = inputSchema.parse(raw),
      chain = makeUsSixMonthRegularChain(parsed.index);
    unitKey = chain.unitKey;
    valid(equal(raw, parsed));
    valid(parsed.receiving.unitKey === unitKey && parsed.transformation.unitKey === unitKey);
    valid(
      parsed.references.datasetId === parsed.receiving.datasetId &&
        parsed.references.datasetId === parsed.transformation.datasetId,
    );
    const boxes = parsed.support.boxes;
    valid(
      equal(
        boxes.map((box) => box.sscc),
        chain.cases,
      ),
    );
    valid(
      new Set([parsed.support.shiftId, ...boxes.map((box) => box.id)]).size === boxes.length + 1,
    );
    valid(new Set(boxes.map((box) => box.deviceBoxId)).size === boxes.length);
    valid(parsed.support.numberSeq === parsed.index + 1);
    const captured = new Date(parsed.support.capturedAt);
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
      parsed.support.numberMonthKey ===
        `${month}${String(captured.getUTCFullYear() % 100).padStart(2, "0")}`,
    );
    return freezeOwned(structuredClone(parsed));
  } catch (cause) {
    throw datasetCasesError("us_dataset_cases_input_invalid", unitKey, cause);
  }
}
/** Coherent receipt bytes are not proof of actual current state; the guarded verifier owns that check. */
export function parseUsDatasetCasesResult(raw: unknown): UsDatasetCasesResult {
  let unitKey = "unknown";
  try {
    safeRaw(raw);
    const parsed = resultSchema.parse(raw);
    const input = parseUsDatasetCasesInput(parsed.input);
    unitKey = input.transformation.unitKey;
    valid(equal(raw, parsed));
    checkUsDatasetCasesEvidence({ ...parsed, input });
    return freezeOwned(structuredClone({ ...parsed, input }));
  } catch (cause) {
    throw datasetCasesError("us_dataset_cases_result_invalid", unitKey, cause);
  }
}
export function caseDemoAuditIdentity(input: UsDatasetCasesInput): Readonly<{
  datasetId: string;
  recipeVersion: "us-processor-six-month-v1";
  recipeDigest: string;
  unitKey: string;
  intentDigest: string;
}> {
  const parsed = parseUsDatasetCasesInput(input);
  return Object.freeze({
    datasetId: parsed.references.datasetId,
    recipeVersion: parsed.version,
    recipeDigest: parsed.definitionDigest,
    unitKey: parsed.transformation.unitKey,
    intentDigest: canonicalExportDigest(parsed),
  });
}
export function caseDemoCommandDigest(input: UsDatasetCasesInput): string {
  const parsed = parseUsDatasetCasesInput(input);
  return canonicalExportDigest({
    commandVersion: 2,
    command: "case.link",
    source: "demo_seed",
    lotId: parsed.outputLotId,
    input: { ssccs: parsed.support.boxes.map((box) => box.sscc).sort() },
    seed: caseDemoAuditIdentity(parsed),
  });
}
export function usDatasetCasesRecordIds(result: UsDatasetCasesResult): readonly string[] {
  const parsed = parseUsDatasetCasesResult(result);
  return Object.freeze([
    ...new Set([
      parsed.support.shift.id,
      ...parsed.support.boxes.map((box) => box.id),
      ...parsed.linked.created.map((link) => link.linkId),
    ]),
  ]);
}
