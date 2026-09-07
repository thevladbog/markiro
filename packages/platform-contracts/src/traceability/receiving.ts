import { UOM_CODES_V1 } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { traceabilityCivilDateSchema, traceabilityQuantitySchema } from "./event-values.js";
import { traceabilityLotSourceSchema } from "./lot-records.js";
import { tlcSchema } from "./lots.js";
import { receivingExemptReceiptSchema } from "./receiving-exemption.js";

const text = (maximum: number) =>
  z
    .string()
    .refine((value) => !value.includes("\u0000") && !/\p{Cs}/u.test(value))
    .trim()
    .min(1)
    .max(maximum)
    .nullable();

/** Structurally valid but potentially incomplete. Never authorizes or finalizes a receipt. */
export const receivingDraftItemSchema = z
  .object({
    productId: platformUuidSchema.nullable(),
    lotLinkMode: z.enum(["create_on_finalize", "link_existing"]),
    lotId: platformUuidSchema.nullable(),
    tlc: tlcSchema.nullable(),
    source: traceabilityLotSourceSchema,
    exemptSupplier: z.boolean(),
    exemptReason: text(2000),
    exemptReceipt: receivingExemptReceiptSchema.nullable().optional(),
    supplierLotReference: text(128),
    quantity: traceabilityQuantitySchema.nullable(),
    unitOfMeasure: z.enum(UOM_CODES_V1).nullable(),
    notes: text(2000),
  })
  .strict();

/** Full draft replacement payload. Missing values are explicit nulls, never inferred defaults. */
export const receivingDraftSchema = z
  .object({
    dateReceived: traceabilityCivilDateSchema.nullable(),
    locationId: platformUuidSchema.nullable(),
    previousSourceLocationId: platformUuidSchema.nullable(),
    receivedAtNote: text(2000),
    notes: text(2000),
    items: z.array(receivingDraftItemSchema).max(100),
    documentIds: z
      .array(platformUuidSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate document link"),
  })
  .strict();

export type ReceivingDraftItem = z.infer<typeof receivingDraftItemSchema>;
export type ReceivingDraft = z.infer<typeof receivingDraftSchema>;
