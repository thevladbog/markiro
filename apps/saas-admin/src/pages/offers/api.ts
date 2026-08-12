import { z } from "zod";

import { platformApiFetch } from "../../api/client.js";
import type { CreateOfferInput } from "../documents/documentDraft.js";

const moneySchema = z.string().regex(/^\d{1,12}\.\d{2}$/);
const nullableIsoDateSchema = z.iso.datetime({ offset: true }).nullable();
const offerStatusSchema = z.enum(["draft", "published", "paid", "cancelled", "expired"]);

const offerSummarySchema = z.object({
  id: z.uuid(),
  tenantId: z.string().min(1),
  status: offerStatusSchema,
  total: moneySchema,
});

const offerLineSchema = z.object({
  id: z.uuid(),
  position: z.number().int().positive(),
  kind: z.enum(["plan", "addon", "service"]),
  catalogVersionId: z.uuid().nullable(),
  nameRu: z.string().min(1),
  nameEn: z.string().min(1),
  quantity: z.number().int().positive(),
  unit: z.string().min(1),
  agreedUnitPrice: moneySchema,
  vatRate: z.string().nullable(),
  vatIncluded: z.boolean(),
  activationPolicy: z.enum(["immediately", "after_current"]).nullable(),
  lineTotal: moneySchema,
});

const offerDetailSchema = offerSummarySchema.extend({
  expiresAt: nullableIsoDateSchema,
  lines: z.array(offerLineSchema),
});

const createOfferLineInputSchema = z.object({
  kind: z.enum(["plan", "addon", "service"]),
  catalogVersionId: z.uuid(),
  nameRu: z.string().trim().min(1).max(300),
  nameEn: z.string().trim().min(1).max(300),
  quantity: z.number().int().positive(),
  unit: z.string().trim().min(1).max(100),
  agreedUnitPrice: moneySchema,
  vatRateBps: z.number().int().min(0).max(10_000).nullable(),
  vatIncluded: z.boolean(),
  activationPolicy: z.enum(["immediately", "after_current"]).nullable(),
});
const createOfferInputSchema = z.object({
  tenantId: z.string().min(1),
  expiresAt: z.iso.date().nullable(),
  lines: z.array(createOfferLineInputSchema).min(1).max(100),
});

export const offerIdSchema = z.uuid();
export type Offer = z.infer<typeof offerSummarySchema>;
export type OfferLine = z.infer<typeof offerLineSchema>;
export type OfferDetail = z.infer<typeof offerDetailSchema>;

export async function listOffers(): Promise<Offer[]> {
  return z.array(offerSummarySchema).parse(await platformApiFetch<unknown>("/offers"));
}

export async function getOffer(id: string): Promise<OfferDetail> {
  const validatedId = offerIdSchema.parse(id);
  return offerDetailSchema.parse(await platformApiFetch<unknown>(`/offers/${validatedId}`));
}

export async function createOffer(input: CreateOfferInput): Promise<OfferDetail> {
  const validated = createOfferInputSchema.parse(input);
  return offerDetailSchema.parse(
    await platformApiFetch<unknown>("/offers", {
      method: "POST",
      body: JSON.stringify(validated),
    }),
  );
}

export function publishOffer(id: string): Promise<OfferDetail> {
  return platformApiFetch(`/offers/${id}/publish`, { method: "POST", body: "{}" });
}

export function payOffer(
  id: string,
  amount: string,
  bankReference: string,
  key: string,
): Promise<{ paymentId: string; fulfilments: string[] }> {
  return platformApiFetch(`/offers/${id}/payment`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ amount, currency: "RUB", bankReference }),
  });
}
