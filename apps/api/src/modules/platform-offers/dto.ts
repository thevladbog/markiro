import { z } from "zod";

const money = z.string().regex(/^\d{1,12}\.\d{2}$/);
const line = z.object({
  kind: z.enum(["plan", "addon", "service"]),
  catalogVersionId: z.uuid().nullable().optional(),
  nameRu: z.string().trim().min(1).max(300),
  nameEn: z.string().trim().min(1).max(300),
  descriptionRu: z.string().max(10_000).nullable().optional(),
  descriptionEn: z.string().max(10_000).nullable().optional(),
  quantity: z.number().int().positive(),
  unit: z.string().trim().min(1).max(100),
  agreedUnitPrice: money,
  catalogUnitPrice: money.nullable().optional(),
  vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  vatIncluded: z.boolean(),
  priceOverrideReason: z.string().trim().max(1000).nullable().optional(),
  activationPolicy: z.enum(["immediately", "after_current"]).nullable().optional(),
});

export const createOfferSchema = z
  .object({
    tenantId: z.string().min(1),
    expiresAt: z.coerce.date().nullable().optional(),
    lines: z.array(line).min(1).max(100),
  })
  .strict();
export type CreateOfferDto = z.infer<typeof createOfferSchema>;

export const offerIdSchema = z.uuid();
export const paymentSchema = z
  .object({
    amount: money,
    currency: z.literal("RUB"),
    bankReference: z.string().trim().min(1).max(200),
  })
  .strict();
export type PaymentDto = z.infer<typeof paymentSchema>;
