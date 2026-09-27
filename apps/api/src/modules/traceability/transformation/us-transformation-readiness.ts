import { createHash } from "node:crypto";
import {
  assessTransformationReadiness,
  TRANSFORMATION_READINESS_RULE_VERSION,
  type TransformationReadinessInput,
} from "@markiro/domain";
import {
  transformationReadinessSchema,
  type TransformationDraftRecord,
} from "@markiro/platform-contracts";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readTransformationReferenceContext } from "./us-transformation-reference-context";

export async function readTransformationReadiness(
  tx: UsMasterDataTransaction,
  tenantId: string,
  saved: TransformationDraftRecord,
  profileCode: TransformationReadinessInput["profileCode"],
) {
  return (await readTransformationFinalizationContext(tx, tenantId, saved, profileCode)).readiness;
}

/** Readiness and pinned evidence are derived from exactly the same resolved facts. */
export async function readTransformationFinalizationContext(
  tx: UsMasterDataTransaction,
  tenantId: string,
  saved: TransformationDraftRecord,
  profileCode: TransformationReadinessInput["profileCode"],
  lockReferences = false,
) {
  const facts = await readTransformationReferenceContext(
    tx,
    tenantId,
    saved.draft,
    profileCode,
    lockReferences,
  );
  const issues = assessTransformationReadiness(facts.input);
  const ruleVersion = TRANSFORMATION_READINESS_RULE_VERSION;
  const inputDigest = createHash("sha256")
    .update(
      JSON.stringify({
        ruleVersion,
        eventId: saved.id,
        draftVersion: saved.draftVersion,
        timeZone: saved.timeZone,
        ...facts,
      }),
    )
    .digest("hex");
  const readiness = transformationReadinessSchema.parse({
    eventId: saved.id,
    expectedDraftVersion: saved.draftVersion,
    state: issues.length ? "incomplete" : "complete",
    ruleVersion,
    inputDigest,
    issues,
  });
  return { ...facts, readiness };
}
