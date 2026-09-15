import type { z } from "zod";
import {
  offerCreateV2Schema,
  offerCreateV4Schema,
  offerDetailV2Schema,
  offerDetailV4Schema,
} from "./commercial.js";
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

export const offerDraftUpdateV4Schema = offerCreateV4Schema
  .omit({ tenantId: true })
  .extend({
    expectedUpdatedAt: platformTimestampSchema,
    idempotencyKey: platformUuidSchema,
  })
  .strict();
export const platformOfferDraftV4Contracts = {
  update: {
    params: platformUuidSchema,
    body: offerDraftUpdateV4Schema,
    response: offerDetailV4Schema,
  },
} as const;
export type OfferDraftUpdateV4 = z.output<typeof offerDraftUpdateV4Schema>;
