import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { shippingDraftRecordSchema } from "./shipping-records.js";

const version = z.number().int().min(1).max(2147483647);
const page = {
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(100000),
};
export const shippingRevisionListQuerySchema = z.object(page).strict();
export const shippingRevisionSummarySchema = z
  .object({
    id: platformUuidSchema,
    rootId: platformUuidSchema,
    eventNumber: shippingDraftRecordSchema.shape.eventNumber,
    revision: version,
    status: z.enum(["draft", "finalized", "amended", "void"]),
    timeZone: shippingDraftRecordSchema.shape.timeZone,
    lifecycleVersion: version,
    currentEventId: platformUuidSchema.nullable(),
    pendingDraftId: platformUuidSchema.nullable(),
    previousRevisionId: platformUuidSchema.nullable(),
    amendmentReason: z.string().min(1).max(2000).nullable(),
    voidReason: z.string().min(1).max(2000).nullable(),
  })
  .strict();
export const shippingRevisionListSchema = z
  .object({
    items: z.array(shippingRevisionSummarySchema).max(100),
    ...page,
    lifecycleVersion: version,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.items.length > value.limit)
      context.addIssue({ code: "custom", path: ["items"], message: "Page exceeds limit" });
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
      const id = item.id.toLowerCase();
      if (
        seen.has(id) ||
        (index > 0 && item.revision <= (value.items[index - 1]?.revision ?? 0)) ||
        item.lifecycleVersion !== value.lifecycleVersion
      )
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "Revision page must be unique and ascending",
        });
      seen.add(id);
    });
  });
export type ShippingRevisionListQuery = z.infer<typeof shippingRevisionListQuerySchema>;
export type ShippingRevisionList = z.infer<typeof shippingRevisionListSchema>;
