import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { shippingDraftRecordSchema } from "./shipping-records.js";
import { shippingFinalizedRecordSchema } from "./shipping-http.js";

const version = z.number().int().min(1).max(2147483647);
const reason = z
  .string()
  .refine((value) => !value.includes("\u0000") && !/\p{Cs}/u.test(value))
  .trim()
  .min(1)
  .max(2000);
const command = { operationKey: platformUuidSchema, expectedLifecycleVersion: version, reason };
export const amendShippingSchema = z.object(command).strict();
export const voidShippingSchema = z
  .object({ ...command, expectedDraftVersion: version.optional() })
  .strict();

const historicalFinalized = z
  .object({ ...shippingFinalizedRecordSchema.shape, status: z.enum(["amended", "void"]) })
  .strict()
  .superRefine((record, context) => {
    const lifecycle = record.lifecycle;
    const original = shippingFinalizedRecordSchema.safeParse({ ...record, status: "finalized" });
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
  .object({ ...shippingDraftRecordSchema.shape, status: z.literal("void") })
  .strict()
  .superRefine((record, context) => {
    const original = shippingDraftRecordSchema.safeParse({ ...record, status: "draft" });
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
export const shippingHistoricalRecordSchema = z.union([
  shippingDraftRecordSchema,
  shippingFinalizedRecordSchema,
  historicalFinalized,
  historicalDraftVoid,
]);
export const shippingLifecycleReceiptSchema = z
  .object({
    receiptVersion: z.literal(1),
    command: z.enum(["shipping.amend", "shipping.void"]),
    operationKey: platformUuidSchema,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    eventId: platformUuidSchema,
    record: z.union([shippingDraftRecordSchema, shippingHistoricalRecordSchema]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.eventId !== value.record.id ||
      (value.command === "shipping.amend" && value.record.status !== "draft") ||
      (value.command === "shipping.void" && value.record.status !== "void")
    )
      context.addIssue({ code: "custom", path: ["record"], message: "Lifecycle receipt mismatch" });
  });

export type ShippingHistoricalRecord = z.infer<typeof shippingHistoricalRecordSchema>;
export type ShippingLifecycleReceipt = z.infer<typeof shippingLifecycleReceiptSchema>;
