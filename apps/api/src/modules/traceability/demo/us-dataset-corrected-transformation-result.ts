import {
  canonicalExportEqual,
  canonicalExportJson,
  ownedUsDemoJsonCopy,
} from "./us-demo-canonical.js";

import { platformUuidSchema } from "@markiro/platform-contracts";
import { z } from "zod";
import {
  assertUsDatasetCorrectedTransformationJson,
  datasetCorrectedTransformationError,
  parseUsDatasetCorrectedTransformationInput,
  type UsDatasetCorrectedTransformationInput,
} from "./us-dataset-corrected-transformation-contract.js";
import {
  checkUsDatasetTransformationEvidence,
  usDatasetTransformationEvidenceFields,
  usDatasetTransformationEvidenceRecordIds,
  type UsDatasetTransformationEvidence,
} from "./us-dataset-transformation-content.js";

export type UsDatasetCorrectedTransformationResult = UsDatasetTransformationEvidence &
  Readonly<{ input: UsDatasetCorrectedTransformationInput }>;

const schema = z.object({ input: z.unknown(), ...usDatasetTransformationEvidenceFields }).strict();
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .pipe(platformUuidSchema);
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_corrected_transformation_evidence_invalid");
}

/** Stored coherence only; the executor separately proves persisted ownership/current origin. */
export function parseUsDatasetCorrectedTransformationResult(
  raw: unknown,
): UsDatasetCorrectedTransformationResult {
  try {
    assertUsDatasetCorrectedTransformationJson(raw);
    const parsed = schema.parse(raw);
    const input = parseUsDatasetCorrectedTransformationInput(parsed.input);
    const result = { ...parsed, input };
    valid(canonicalExportEqual(raw, result));
    checkUsDatasetTransformationEvidence(result);
    valid(
      canonicalExportJson(result.inputLots) ===
        canonicalExportJson(input.receivingOrigin.inputLots),
    );
    const ownedIds = usDatasetTransformationEvidenceRecordIds(result);
    const upstreamIds = new Set([input.receivingOrigin.rootId, input.receivingOrigin.eventId]);
    valid(ownedIds.every((id) => !upstreamIds.has(id)));
    for (const id of [
      ...ownedIds,
      result.createInput.operationKey,
      result.finalizeInput.operationKey,
    ])
      uuid.parse(id);
    return ownedUsDemoJsonCopy(result);
  } catch (cause) {
    throw datasetCorrectedTransformationError(
      "us_dataset_corrected_transformation_result_invalid",
      cause,
    );
  }
}

export function usDatasetCorrectedTransformationRecordIds(
  result: UsDatasetCorrectedTransformationResult,
): readonly string[] {
  return usDatasetTransformationEvidenceRecordIds(
    parseUsDatasetCorrectedTransformationResult(result),
  );
}
