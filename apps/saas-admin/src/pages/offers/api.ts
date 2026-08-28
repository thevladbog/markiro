import {
  platformCommercialContracts,
  type CreateOfferInput,
  type Offer as SharedOffer,
  type OfferDetail,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type Offer = SharedOffer;
export type OfferLine = OfferDetail["lines"][number];
export type { OfferDetail };

export function listOffers() {
  return platformApiFetch("/offers", {
    responseSchema: platformCommercialContracts.offers.list.response,
  });
}

export function getOffer(id: string) {
  const validatedId = platformCommercialContracts.offers.detail.params.parse(id);
  return platformApiFetch(`/offers/${validatedId}`, {
    responseSchema: platformCommercialContracts.offers.detail.response,
  });
}

export function createOffer(input: CreateOfferInput) {
  const validated = platformCommercialContracts.offers.create.body.parse(input);
  return platformApiFetch("/offers", {
    responseSchema: platformCommercialContracts.offers.create.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export function publishOffer(id: string) {
  const validatedId = platformCommercialContracts.offers.publish.params.parse(id);
  return platformApiFetch(`/offers/${validatedId}/publish`, {
    responseSchema: platformCommercialContracts.offers.publish.response,
    method: "POST",
    body: "{}",
  });
}

export function reviseOffer(id: string, idempotencyKey: string) {
  const validatedId = platformCommercialContracts.offers.revise.params.parse(id);
  const body = platformCommercialContracts.offers.revise.body.parse({ idempotencyKey });
  return platformApiFetch(`/offers/${validatedId}/revise`, {
    responseSchema: platformCommercialContracts.offers.revise.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function payOffer(id: string, amount: string, bankReference: string, key: string) {
  const validatedId = platformCommercialContracts.offers.payment.params.parse(id);
  const validated = platformCommercialContracts.offers.payment.body.parse({
    amount,
    currency: "RUB",
    bankReference,
  });
  return platformApiFetch(`/offers/${validatedId}/payment`, {
    responseSchema: platformCommercialContracts.offers.payment.response,
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify(validated),
  });
}
