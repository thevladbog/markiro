import { UOM_CODES_V1, type TransformationDraftValue } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { traceabilityCivilDateSchema, traceabilityQuantitySchema } from "./event-values.js";
import { tlcSchema } from "./lots.js";

const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes("\u0000") && !/\p{Cs}/u.test(value))
    .nullable();
const quantity = traceabilityQuantitySchema.nullable();
const unitOfMeasure = z.enum(UOM_CODES_V1).nullable();
const input = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ftl_lot"),
      lotId: platformUuidSchema.nullable(),
      quantity,
      unitOfMeasure,
    })
    .strict(),
  z
    .object({
      kind: z.literal("non_ftl"),
      productId: platformUuidSchema.nullable(),
      sourceLocationId: platformUuidSchema.nullable(),
      reference: text(2000),
      quantity,
      unitOfMeasure,
    })
    .strict(),
]);
const output = z
  .object({
    productId: platformUuidSchema.nullable(),
    tlc: tlcSchema.nullable(),
    quantity,
    unitOfMeasure,
  })
  .strict();
/** A full replacement permits explicit nulls while preventing client-owned output lot IDs. */
export const transformationDraftSchema = z
  .object({
    eventDate: traceabilityCivilDateSchema.nullable(),
    processorLocationId: platformUuidSchema.nullable(),
    reason: z
      .enum(["commingling_and_repacking", "repacking", "relabeling", "processing", "other"])
      .nullable(),
    reasonNote: text(2000),
    notes: text(2000),
    inputs: z.array(input).max(100),
    outputs: z.array(output).max(100),
    documentIds: z
      .array(platformUuidSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate document link"),
  })
  .strict()
  .superRefine((draft, context) => {
    const seen = new Set<string>();
    draft.inputs.forEach((row, index) => {
      if (row.kind !== "ftl_lot" || row.lotId === null) return;
      if (seen.has(row.lotId))
        context.addIssue({
          code: "custom",
          path: ["inputs", index, "lotId"],
          message: "Duplicate input lot",
        });
      seen.add(row.lotId);
    });
  });

export type TransformationDraft = z.infer<typeof transformationDraftSchema>;
const _structuralCheck: TransformationDraft extends TransformationDraftValue ? true : never = true;
void _structuralCheck;
