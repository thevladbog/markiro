import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { receivingDraftItemSchema, receivingDraftSchema } from "./receiving.js";
import { receivingFinalizationSnapshotV2Schema } from "./receiving-finalization-v2.js";

const version = z.number().int().min(1).max(2147483647);
const reason = z
  .string()
  .refine((value) => !value.includes("\u0000") && !/\p{Cs}/u.test(value))
  .trim()
  .min(1)
  .max(2000);
const command = {
  commandVersion: z.literal(2),
  operationKey: platformUuidSchema,
  expectedLifecycleVersion: version,
};

export const amendReceivingSchema = z.object({ ...command, reason }).strict();
export const voidReceivingSchema = z
  .object({
    ...command,
    expectedDraftVersion: version.nullable(),
    reason,
  })
  .strict();

export const receivingAmendmentDraftSchema = receivingDraftSchema
  .extend({
    items: z
      .array(
        receivingDraftItemSchema
          .extend({
            previousLineNo: z.number().int().min(1).max(100).nullable(),
          })
          .strict(),
      )
      .max(100)
      .refine((items) => {
        const bindings = items.flatMap((item) =>
          item.previousLineNo === null ? [] : [item.previousLineNo],
        );
        return new Set(bindings).size === bindings.length;
      }, "Duplicate predecessor line binding"),
  })
  .strict();

export const saveReceivingAmendmentSchema = z
  .object({
    ...command,
    expectedDraftVersion: version,
    draft: receivingAmendmentDraftSchema,
  })
  .strict();
export const finalizeReceivingRevisionSchema = z
  .object({
    ...command,
    expectedDraftVersion: version,
    previousRevisionId: platformUuidSchema.nullable(),
    expectedInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedExemptLines:
      receivingFinalizationSnapshotV2Schema.shape.confirmation.shape.reviewedExemptLines,
  })
  .strict();

export type AmendReceivingInput = z.infer<typeof amendReceivingSchema>;
export type VoidReceivingInput = z.infer<typeof voidReceivingSchema>;
export type ReceivingAmendmentDraft = z.infer<typeof receivingAmendmentDraftSchema>;
export type SaveReceivingAmendmentInput = z.infer<typeof saveReceivingAmendmentSchema>;
export type FinalizeReceivingRevisionInput = z.infer<typeof finalizeReceivingRevisionSchema>;
