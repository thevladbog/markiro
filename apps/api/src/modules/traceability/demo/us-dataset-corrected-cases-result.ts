import { canonicalExportDigest } from "@markiro/domain";
import { platformUuidSchema } from "@markiro/platform-contracts";
import { z } from "zod";
import {
  checkUsDatasetCasesEvidence,
  usDatasetCasesEvidenceFields,
  type UsDatasetCasesEvidence,
} from "./us-dataset-cases-content.js";
import {
  parseUsDatasetCorrectedCasesInput,
  type UsDatasetCorrectedCasesInput,
} from "./us-dataset-corrected-cases-contract.js";
import { assertUsDatasetCorrectedTransformationJson } from "./us-dataset-corrected-transformation-contract.js";

export type UsDatasetCorrectedCasesResult = UsDatasetCasesEvidence &
  Readonly<{ input: UsDatasetCorrectedCasesInput }>;
type ErrorCode =
  | "us_dataset_corrected_cases_prerequisite_incomplete"
  | "us_dataset_corrected_cases_dependency_conflict"
  | "us_dataset_corrected_cases_result_invalid"
  | "us_dataset_corrected_cases_conflict"
  | "us_dataset_corrected_cases_mismatch";
export function datasetCorrectedCasesError(code: ErrorCode, cause?: unknown): Error {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), {
    unitKey: "correction_0001",
    stage: "cases",
  });
}
const schema = z.object({ input: z.unknown(), ...usDatasetCasesEvidenceFields }).strict();
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .pipe(platformUuidSchema);
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_corrected_cases_evidence_invalid");
}
/** Traverses only module-owned copies after descriptor-safe validation. */
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}
function ownedIds(result: UsDatasetCorrectedCasesResult): readonly string[] {
  return [
    result.support.shift.id,
    ...result.support.boxes.map(({ id }) => id),
    ...result.linked.created.map(({ linkId }) => linkId),
  ];
}

/** Receipt coherence only; execution separately proves actual persisted state and ownership. */
export function parseUsDatasetCorrectedCasesResult(raw: unknown): UsDatasetCorrectedCasesResult {
  try {
    assertUsDatasetCorrectedTransformationJson(raw);
    const parsed = schema.parse(raw);
    const input = parseUsDatasetCorrectedCasesInput(parsed.input);
    const result = { ...parsed, input };
    valid(canonicalExportDigest(raw) === canonicalExportDigest(result));
    checkUsDatasetCasesEvidence(result);
    const ids = ownedIds(result);
    const knownIds = new Set([
      input.references.datasetId,
      input.receivingOrigin.rootId,
      input.receivingOrigin.eventId,
      ...input.receivingOrigin.inputLots.map(({ lotId }) => lotId),
      input.transformationOrigin.rootId,
      input.transformationOrigin.eventId,
      input.outputLotId,
      input.outputProductId,
    ]);
    valid(ids.length === 121 && new Set(ids).size === ids.length);
    valid(ids.every((id) => !knownIds.has(id)));
    for (const id of [...ids, result.operationKey]) uuid.parse(id);
    return freezeOwned(structuredClone(result));
  } catch (cause) {
    throw datasetCorrectedCasesError("us_dataset_corrected_cases_result_invalid", cause);
  }
}

export function usDatasetCorrectedCasesRecordIds(
  result: UsDatasetCorrectedCasesResult,
): readonly string[] {
  return Object.freeze(ownedIds(parseUsDatasetCorrectedCasesResult(result)));
}
export function correctedCaseDemoAuditIdentity(input: UsDatasetCorrectedCasesInput): Readonly<{
  datasetId: string;
  recipeVersion: "us-processor-six-month-v1";
  recipeDigest: string;
  unitKey: "correction_0001";
  intentDigest: string;
}> {
  const parsed = parseUsDatasetCorrectedCasesInput(input);
  return Object.freeze({
    datasetId: parsed.references.datasetId,
    recipeVersion: parsed.version,
    recipeDigest: parsed.definitionDigest,
    unitKey: parsed.transformation.unitKey,
    intentDigest: canonicalExportDigest(parsed),
  });
}
export function correctedCaseDemoCommandDigest(input: UsDatasetCorrectedCasesInput): string {
  const parsed = parseUsDatasetCorrectedCasesInput(input);
  return canonicalExportDigest({
    commandVersion: 2,
    command: "case.link",
    source: "demo_seed",
    lotId: parsed.outputLotId,
    input: { ssccs: parsed.support.boxes.map(({ sscc }) => sscc).sort() },
    seed: correctedCaseDemoAuditIdentity(parsed),
  });
}
