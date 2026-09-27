import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { provisionUsTraceabilityProfileSchema } from "./profile.js";
import { shippingDraftSchema } from "./shipping-draft.js";

const version = z.number().int().min(1).max(2147483647);
export const createShippingDraftSchema = z
  .object({ operationKey: platformUuidSchema, draft: shippingDraftSchema })
  .strict();
export const saveShippingDraftSchema = createShippingDraftSchema
  .safeExtend({ expectedDraftVersion: version })
  .strict();

export const shippingDraftRecordSchema = z
  .object({
    id: platformUuidSchema,
    eventNumber: z.string().regex(/^SHP-\d{2}-\d{4,10}$/),
    revision: version,
    draftVersion: version,
    timeZone: provisionUsTraceabilityProfileSchema.shape.timeZone,
    createdBy: z.string().min(1).max(128),
    updatedBy: z.string().min(1).max(128),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    status: z.literal("draft"),
    draft: shippingDraftSchema,
    lifecycle: z
      .object({
        rootId: platformUuidSchema,
        lifecycleVersion: version,
        currentEventId: platformUuidSchema.nullable(),
        pendingDraftId: platformUuidSchema.nullable(),
        previousRevisionId: platformUuidSchema.nullable(),
        amendmentReason: z.string().trim().min(1).max(2000).nullable(),
        /** Optional so pre-lifecycle operation receipts remain byte-for-byte readable. */
        supersededByEventId: platformUuidSchema.nullable().optional(),
        supersededAt: z.iso.datetime().nullable().optional(),
        supersededBy: z.string().min(1).max(128).nullable().optional(),
        voidedAt: z.iso.datetime().nullable().optional(),
        voidedBy: z.string().min(1).max(128).nullable().optional(),
        voidReason: z.string().min(1).max(2000).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateShippingDraftInput = z.infer<typeof createShippingDraftSchema>;
export type SaveShippingDraftInput = z.infer<typeof saveShippingDraftSchema>;
export type ShippingDraftRecord = z.infer<typeof shippingDraftRecordSchema>;
