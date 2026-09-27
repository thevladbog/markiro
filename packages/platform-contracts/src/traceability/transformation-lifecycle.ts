import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import {
  transformationDraftRecordSchema,
  transformationFinalizedRecordSchema,
} from "./transformation-records.js";

const version = z.number().int().min(1).max(2147483647);
const reason = z
  .string()
  .refine((value) => !value.includes("\u0000") && !/\p{Cs}/u.test(value))
  .trim()
  .min(1)
  .max(2000);
const command = { operationKey: platformUuidSchema, expectedLifecycleVersion: version, reason };

export const amendTransformationSchema = z.object(command).strict();
export const voidTransformationSchema = z
  .object({ ...command, expectedDraftVersion: version.optional() })
  .strict();

const historicalFinalized = z
  .object({ ...transformationFinalizedRecordSchema.shape, status: z.enum(["amended", "void"]) })
  .strict()
  .superRefine((record, context) => {
    const lifecycle = record.lifecycle;
    const original = transformationFinalizedRecordSchema.safeParse({
      ...record,
      status: "finalized",
    });
    if (!original.success)
      for (const issue of original.error.issues)
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    if (
      !lifecycle ||
      (record.status === "amended" &&
        (!lifecycle.supersededByEventId ||
          !lifecycle.supersededAt ||
          !lifecycle.supersededBy ||
          lifecycle.voidedAt !== null)) ||
      (record.status === "void" &&
        (!lifecycle.voidedAt || !lifecycle.voidedBy || !lifecycle.voidReason))
    )
      context.addIssue({
        code: "custom",
        path: ["lifecycle"],
        message: "Historical lifecycle evidence required",
      });
  });
const historicalDraftVoid = z
  .object({ ...transformationDraftRecordSchema.shape, status: z.literal("void") })
  .strict()
  .superRefine((record, context) => {
    const original = transformationDraftRecordSchema.safeParse({ ...record, status: "draft" });
    if (!original.success)
      for (const issue of original.error.issues)
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    if (
      !record.lifecycle ||
      !record.lifecycle.voidedAt ||
      !record.lifecycle.voidedBy ||
      !record.lifecycle.voidReason
    )
      context.addIssue({
        code: "custom",
        path: ["lifecycle"],
        message: "Draft void evidence required",
      });
  });
export const transformationHistoricalRecordSchema = z.union([
  transformationFinalizedRecordSchema,
  historicalFinalized,
  historicalDraftVoid,
]);
export const transformationLifecycleReceiptSchema = z
  .object({
    receiptVersion: z.literal(1),
    command: z.enum(["transformation.amend", "transformation.void"]),
    operationKey: platformUuidSchema,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    eventId: platformUuidSchema,
    record: z.union([transformationDraftRecordSchema, transformationHistoricalRecordSchema]),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.eventId !== receipt.record.id ||
      (receipt.command === "transformation.amend" && receipt.record.status !== "draft") ||
      (receipt.command === "transformation.void" && receipt.record.status !== "void")
    )
      context.addIssue({ code: "custom", path: ["record"], message: "Lifecycle receipt mismatch" });
  });

export type AmendTransformationInput = z.infer<typeof amendTransformationSchema>;
export type VoidTransformationInput = z.infer<typeof voidTransformationSchema>;
export type TransformationHistoricalRecord = z.infer<typeof transformationHistoricalRecordSchema>;
export type TransformationLifecycleReceipt = z.infer<typeof transformationLifecycleReceiptSchema>;
