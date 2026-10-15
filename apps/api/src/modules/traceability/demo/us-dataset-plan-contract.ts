import { canonicalExportEqual } from "./us-demo-canonical.js";

import { usPlanInternalApproveInputSchema } from "@markiro/platform-contracts";
import { z } from "zod";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import {
  US_DATASET_PLAN_CONTENT_VERSION,
  usDatasetPlanContent,
} from "./us-dataset-plan-content.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
export function datasetPlanError(code: "incomplete" | "conflict", cause?: unknown) {
  return Object.assign(
    new Error(`us_dataset_plan_${code}`, cause === undefined ? undefined : { cause }),
    { unitKey: "plan", stage: "plan" },
  );
}
export function equalPlan(left: unknown, right: unknown): void {
  if (!canonicalExportEqual(left, right)) throw datasetPlanError("conflict");
}
export const planInputSchema = z
  .object({
    codec: z.literal(US_DATASET_PLAN_CONTENT_VERSION),
    datasetId: uuid,
    version: z.literal(usSixMonthDefinition.version),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    referenceDigest: digest,
    configuredFactsDigest: digest,
    content: z.unknown(),
    draft: z
      .object({
        id: uuid,
        versionNumber: z.number().int().positive(),
        draftRevision: z.number().int().positive(),
        createdBy: uuid,
        createdAt: z.iso.datetime(),
      })
      .strict(),
    approval: usPlanInternalApproveInputSchema,
  })
  .strict();
export type UsDatasetPlanInput = z.infer<typeof planInputSchema>;
export function parsePlanInput(raw: unknown): UsDatasetPlanInput {
  try {
    assertBoundedSyntheticJson(raw);
    const value = planInputSchema.parse(raw);
    equalPlan(value.content, usDatasetPlanContent);
    equalPlan(value.approval, {
      versionId: value.draft.id,
      expectedRevision: value.draft.draftRevision,
      idempotencyKey: value.approval.idempotencyKey,
      confirmations: {
        procedures: true,
        backupAndRecovery: true,
        contact: true,
        nonFarmScope: true,
      },
    });
    equalPlan(raw, value);
    return value;
  } catch (cause) {
    throw datasetPlanError("conflict", cause);
  }
}
const resultSchema = z
  .object({
    datasetId: uuid,
    version: z.literal(usSixMonthDefinition.version),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    state: z.literal("plan_verified"),
    datasetComplete: z.literal(false),
    contentVersion: z.literal(US_DATASET_PLAN_CONTENT_VERSION),
    plan: z
      .object({
        id: uuid,
        versionNumber: z.number().int().positive(),
        draftRevision: z.number().int().positive(),
        createdBy: uuid,
        createdAt: z.iso.datetime(),
        approvedBy: uuid,
        approvedAt: z.iso.datetime(),
      })
      .strict(),
    approvedEvidenceDigest: digest,
    artifact: z
      .object({
        descriptorDigest: digest,
        sha256: digest,
        byteSize: z.number().int().min(1).max(8_000_000),
        rendererVersion: z.enum(["us-plan-pdf-v1", "us-plan-pdf-v2"]),
        contentType: z.literal("application/pdf"),
      })
      .strict(),
  })
  .strict();
export type UsDatasetPlanResult = Readonly<z.infer<typeof resultSchema>>;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function parseUsDatasetPlanResult(raw: unknown): UsDatasetPlanResult {
  try {
    assertBoundedSyntheticJson(raw);
    const result = resultSchema.parse(raw);
    equalPlan(result, raw);
    return freeze(result);
  } catch (cause) {
    throw datasetPlanError("conflict", cause);
  }
}
