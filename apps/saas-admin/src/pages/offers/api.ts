import { z } from "zod";

import { platformApiFetch } from "../../api/client.js";
import type { CreateOfferInput } from "../documents/types.js";

const moneySchema = z.string().regex(/^\d{1,12}\.\d{2}$/);
const uuidSchema = z.uuid();
const offerStatusSchema = z.enum(["draft", "published", "paid", "cancelled"]);
const offerLineSchema = z.object({
  id: uuidSchema,
  kind: z.enum(["plan", "addon", "service"]),
  catalogVersionId: uuidSchema.nullable(),
  nameRu: z.string().min(1).max(300),
  nameEn: z.string().min(1).max(300),
  descriptionRu: z.string().nullable().optional(),
  descriptionEn: z.string().nullable().optional(),
  quantity: z.number().int().positive(),
  unit: z.string().min(1).max(100),
  catalogUnitPrice: moneySchema.nullable().optional(),
  agreedUnitPrice: moneySchema,
  priceOverrideReason: z.string().nullable().optional(),
  vatRate: moneySchema.nullable(),
  vatIncluded: z.boolean(),
  activationPolicy: z.enum(["immediately", "after_current"]).nullable(),
  lineTotal: moneySchema,
});
const offerSummarySchema = z.object({
  id: uuidSchema,
  tenantId: z.string().min(1),
  status: offerStatusSchema,
  total: moneySchema,
});
const offerDetailSchema = offerSummarySchema.extend({ lines: z.array(offerLineSchema) });
const createOfferInputSchema = z.object({
  tenantId: z.string().min(1),
  expiresAt: z.string().date().nullable(),
  lines: z
    .array(
      z.object({
        kind: z.enum(["plan", "addon", "service"]),
        catalogVersionId: uuidSchema,
        nameRu: z.string().trim().min(1).max(300),
        nameEn: z.string().trim().min(1).max(300),
        descriptionRu: z.string().nullable().optional(),
        descriptionEn: z.string().nullable().optional(),
        quantity: z.number().int().positive(),
        unit: z.string().trim().min(1).max(100),
        agreedUnitPrice: moneySchema,
        priceOverrideReason: z.string().trim().max(1000).nullable().optional(),
        vatRateBps: z.number().int().min(0).max(10_000).nullable(),
        vatIncluded: z.boolean(),
        activationPolicy: z.enum(["immediately", "after_current"]).nullable(),
      }),
    )
    .min(1)
    .max(100),
});

export interface OfferLine {
  id: string;
  kind: "plan" | "addon" | "service";
  nameRu: string;
  quantity: number;
  agreedUnitPrice: string;
  lineTotal: string;
}
export interface Offer {
  id: string;
  tenantId: string;
  status: "draft" | "published" | "paid" | "cancelled";
  total: string;
  lines?: OfferLine[];
}

export function listOffers(): Promise<Offer[]> {
  return platformApiFetch<unknown>("/offers").then((response) =>
    z.array(offerSummarySchema).parse(response),
  );
}
export function getOffer(id: string): Promise<OfferDetail> {
  const validatedId = uuidSchema.parse(id);
  return platformApiFetch<unknown>(`/offers/${validatedId}`).then((response) =>
    offerDetailSchema.parse(response),
  );
}
export type OfferDetail = z.infer<typeof offerDetailSchema>;
export function createOffer(input: CreateOfferInput): Promise<OfferDetail> {
  const validated = createOfferInputSchema.parse(input);
  return platformApiFetch<unknown>("/offers", {
    method: "POST",
    body: JSON.stringify(validated),
  }).then((response) => offerDetailSchema.parse(response));
}
export function publishOffer(id: string): Promise<Offer> {
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
