import { z } from "zod";
import { assessCoverageReview, COVERAGE_STATUSES, isTlcSourceReferenceUrl } from "@markiro/domain";
import { platformUuidSchema } from "../primitives.js";
import { traceabilityCivilDateSchema, traceabilityQuantitySchema } from "./event-values.js";
import { preservedTlcSchema } from "./lots.js";
import { provisionUsTraceabilityProfileSchema } from "./profile.js";
import { transformationDraftSchema } from "./transformation-draft.js";

const version = z.number().int().min(1).max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.string().trim().min(1).max(128);
const description = z.string().min(1).max(2000);
const identity = z.uuid();
const quantity = z.string().refine((value) => {
  const parsed = traceabilityQuantitySchema.safeParse(value);
  return parsed.success && parsed.data === value;
});

export const createTransformationDraftSchema = z
  .object({ operationKey: platformUuidSchema, draft: transformationDraftSchema })
  .strict();
export const saveTransformationDraftSchema = createTransformationDraftSchema
  .safeExtend({ expectedDraftVersion: version })
  .strict();
export const finalizeTransformationSchema = z
  .object({
    operationKey: platformUuidSchema,
    expectedDraftVersion: version,
    expectedInputDigest: digest,
  })
  .strict();

const recordBase = {
  id: identity,
  eventNumber: z.string().regex(/^TRN-\d{2}-\d{4,10}$/),
  revision: version,
  draftVersion: version,
  timeZone: provisionUsTraceabilityProfileSchema.shape.timeZone,
  createdBy: actor,
  updatedBy: actor,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Optional only so original v1 operation receipts remain byte-for-byte readable. */
  lifecycle: z
    .object({
      rootId: identity,
      lifecycleVersion: version,
      currentEventId: identity.nullable(),
      pendingDraftId: identity.nullable(),
      previousRevisionId: identity.nullable(),
      amendmentReason: z.string().trim().min(1).max(2000).nullable(),
      supersededByEventId: identity.nullable(),
      supersededAt: z.iso.datetime().nullable(),
      supersededBy: actor.nullable(),
      voidedAt: z.iso.datetime().nullable(),
      voidedBy: actor.nullable(),
      voidReason: z.string().trim().min(1).max(2000).nullable(),
    })
    .strict()
    .optional(),
};
export const transformationDraftRecordSchema = z
  .object({ ...recordBase, status: z.literal("draft"), draft: transformationDraftSchema })
  .strict()
  .superRefine((value, context) => {
    if (value.revision > 1 && (!value.lifecycle || !value.lifecycle.previousRevisionId))
      context.addIssue({
        code: "custom",
        path: ["lifecycle"],
        message: "Revision predecessor required",
      });
  });

const preservedText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine(
      (value) => value.trim().length > 0 && !value.includes("\u0000") && !/\p{Cs}/u.test(value),
    );
const coverage = z
  .object({
    coverageStatus: z.enum(COVERAGE_STATUSES),
    coverageRationale: preservedText(2000),
    ftlCategory: preservedText(200).nullable(),
    ftlSourceUrl: preservedText(2048).nullable(),
    ftlSourceVersion: preservedText(128).nullable(),
    reviewedBy: preservedText(128),
    reviewedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine(
    (value) => assessCoverageReview(value, "US_FSMA204_PROCESSOR").state === "reviewed",
    "Frozen coverage must retain a complete actual review",
  );
const product = z.object({ id: identity, description, coverage }).strict();
const location = z.object({ id: identity, description }).strict();
const locationSource = location.extend({ kind: z.literal("location") }).strict();
// id always identifies the described source location; for a reference it is the resolved location.
const lotSource = z.discriminatedUnion("kind", [
  locationSource,
  location
    .extend({
      kind: z.literal("reference"),
      referenceKind: z.literal("web_url"),
      referenceValue: z.string().max(1024).refine(isTlcSourceReferenceUrl),
    })
    .strict(),
]);
const snapshotInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ftl_lot"),
      lineNo: z.number().int().min(1).max(100),
      lotId: identity,
      product,
      tlc: preservedTlcSchema,
      source: lotSource,
      quantity,
      unitOfMeasure: transformationDraftSchema.shape.outputs.element.shape.unitOfMeasure.unwrap(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("non_ftl"),
      lineNo: z.number().int().min(1).max(100),
      product,
      source: locationSource,
      reference: description,
      quantity,
      unitOfMeasure: transformationDraftSchema.shape.outputs.element.shape.unitOfMeasure.unwrap(),
    })
    .strict(),
]);
const snapshotOutput = z
  .object({
    lineNo: z.number().int().min(1).max(100),
    lotId: identity,
    product,
    tlc: preservedTlcSchema,
    source: locationSource,
    quantity,
    unitOfMeasure: transformationDraftSchema.shape.outputs.element.shape.unitOfMeasure.unwrap(),
  })
  .strict();
export const transformationFinalizationSnapshotV1Schema = z
  .object({
    snapshotVersion: z.literal(1),
    eventId: identity,
    eventNumber: z.string().regex(/^TRN-\d{2}-\d{4,10}$/),
    revision: version,
    previousRevisionId: identity.optional(),
    eventDate: traceabilityCivilDateSchema,
    timeZone: provisionUsTraceabilityProfileSchema.shape.timeZone,
    processor: location,
    reason: transformationDraftSchema.shape.reason.unwrap(),
    reasonNote: transformationDraftSchema.shape.reasonNote,
    notes: transformationDraftSchema.shape.notes,
    inputs: z.array(snapshotInput).min(1).max(100),
    outputs: z.array(snapshotOutput).min(1).max(100),
    documents: z
      .array(z.object({ id: identity, type: description, number: description }).strict())
      .min(1)
      .max(100),
    finalizedBy: actor,
    finalizedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const duplicate = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    if ((snapshot.revision === 1) !== (snapshot.previousRevisionId === undefined))
      duplicate(["previousRevisionId"], "Predecessor required only after revision 1");
    const inputLines = new Set<number>();
    const inputLots = new Set<string>();
    snapshot.inputs.forEach((input, index) => {
      const expectedFtl = input.kind === "ftl_lot";
      const actualFtl = ["covered", "contains_ftl_same_form"].includes(
        input.product.coverage.coverageStatus,
      );
      if (expectedFtl ? !actualFtl : input.product.coverage.coverageStatus !== "not_covered")
        duplicate(
          ["inputs", index, "product", "coverage"],
          "Coverage must match the input classification",
        );
      if (inputLines.has(input.lineNo))
        duplicate(["inputs", index, "lineNo"], "Duplicate input line");
      inputLines.add(input.lineNo);
      if (input.kind === "ftl_lot") {
        const lotId = input.lotId.toLowerCase();
        if (inputLots.has(lotId)) duplicate(["inputs", index, "lotId"], "Duplicate input lot");
        inputLots.add(lotId);
      }
    });
    const outputLines = new Set<number>();
    const outputLots = new Set<string>();
    snapshot.outputs.forEach((output, index) => {
      if (!["covered", "contains_ftl_same_form"].includes(output.product.coverage.coverageStatus))
        duplicate(
          ["outputs", index, "product", "coverage"],
          "Output requires reviewed FTL coverage",
        );
      if (outputLines.has(output.lineNo))
        duplicate(["outputs", index, "lineNo"], "Duplicate output line");
      outputLines.add(output.lineNo);
      const lotId = output.lotId.toLowerCase();
      if (outputLots.has(lotId)) duplicate(["outputs", index, "lotId"], "Duplicate output lot");
      if (inputLots.has(lotId))
        duplicate(["outputs", index, "lotId"], "Input lot cannot be an output lot");
      outputLots.add(lotId);
      if (
        output.source.id.toLowerCase() !== snapshot.processor.id.toLowerCase() ||
        output.source.description !== snapshot.processor.description
      )
        duplicate(["outputs", index, "source"], "Output source must be the processor");
    });
    const documentIds = new Set<string>();
    snapshot.documents.forEach((document, index) => {
      const id = document.id.toLowerCase();
      if (documentIds.has(id)) duplicate(["documents", index, "id"], "Duplicate document");
      documentIds.add(id);
    });
  });
export const transformationFinalizedRecordSchema = z
  .object({
    ...recordBase,
    status: z.literal("finalized"),
    finalizedAt: z.iso.datetime(),
    finalizedBy: actor,
    snapshot: transformationFinalizationSnapshotV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.id !== value.snapshot.eventId ||
      value.eventNumber !== value.snapshot.eventNumber ||
      value.revision !== value.snapshot.revision ||
      (value.lifecycle?.previousRevisionId ?? undefined) !== value.snapshot.previousRevisionId ||
      value.timeZone !== value.snapshot.timeZone ||
      value.finalizedBy !== value.snapshot.finalizedBy ||
      value.finalizedAt !== value.snapshot.finalizedAt
    )
      context.addIssue({
        code: "custom",
        path: ["snapshot"],
        message: "Snapshot identity must match record",
      });
  });
export type CreateTransformationDraftInput = z.infer<typeof createTransformationDraftSchema>;
export type SaveTransformationDraftInput = z.infer<typeof saveTransformationDraftSchema>;
export type FinalizeTransformationInput = z.infer<typeof finalizeTransformationSchema>;
export type TransformationDraftRecord = z.infer<typeof transformationDraftRecordSchema>;
export type TransformationFinalizedRecord = z.infer<typeof transformationFinalizedRecordSchema>;
export type TransformationFinalizationSnapshotV1 = z.infer<
  typeof transformationFinalizationSnapshotV1Schema
>;
