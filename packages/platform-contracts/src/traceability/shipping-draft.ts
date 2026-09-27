import { UOM_CODES_V1 } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { traceabilityCivilDateSchema, traceabilityQuantitySchema } from "./event-values.js";

const text = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !value.includes("\u0000") && !/\p{Cs}/u.test(value));

/** A selected existing lot may be saved before its quantity and unit are entered. */
export const shippingItemInputSchema = z
  .object({
    lotId: platformUuidSchema,
    quantity: traceabilityQuantitySchema.nullable(),
    unitOfMeasure: z.enum(UOM_CODES_V1).nullable(),
  })
  .strict();

export const shippingDraftSchema = z
  .object({
    eventDate: traceabilityCivilDateSchema.nullable(),
    shipFromLocationId: platformUuidSchema.nullable(),
    recipientLocationId: platformUuidSchema.nullable(),
    carrierReference: text.nullable(),
    notes: text.nullable(),
    items: z.array(shippingItemInputSchema).max(100),
    documentIds: z.array(platformUuidSchema).max(100),
  })
  .strict()
  .superRefine((draft, context) => {
    const lots = new Set<string>();
    draft.items.forEach((line, index) => {
      const id = line.lotId.toLowerCase();
      if (lots.has(id))
        context.addIssue({
          code: "custom",
          path: ["items", index, "lotId"],
          message: "Duplicate lot line",
        });
      lots.add(id);
    });
    const documents = new Set<string>();
    draft.documentIds.forEach((id, index) => {
      const key = id.toLowerCase();
      if (documents.has(key))
        context.addIssue({
          code: "custom",
          path: ["documentIds", index],
          message: "Duplicate document link",
        });
      documents.add(key);
    });
  });

export type ShippingDraft = z.infer<typeof shippingDraftSchema>;
