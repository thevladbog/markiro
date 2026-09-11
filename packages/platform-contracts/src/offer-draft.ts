import type { z } from "zod";
import { offerCreateV2Schema, offerDetailV2Schema } from "./commercial.js";
import { platformTimestampSchema, platformUuidSchema } from "./primitives.js";

export const offerDraftUpdateSchema = offerCreateV2Schema
  .omit({ tenantId: true })
  .extend({
    expectedUpdatedAt: platformTimestampSchema,
    idempotencyKey: platformUuidSchema,
  })
  .strict();

export type OfferDraftUpdate = z.output<typeof offerDraftUpdateSchema>;
export const platformOfferDraftContracts = {
  update: {
    params: platformUuidSchema,
    body: offerDraftUpdateSchema,
    response: offerDetailV2Schema,
  },
} as const;
