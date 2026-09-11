import {
  platformCommercialV2Contracts,
  COMMERCIAL_VERSION_HEADER,
  COMMERCIAL_VERSION,
  type CreateOfferV2 as CreateOfferInput,
  type Offer as SharedOffer,
  type OfferDetailV2 as OfferDetail,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type Offer = SharedOffer;
export type OfferLine = OfferDetail["lines"][number];
export type { OfferDetail };

export function listOffers() {
  return platformApiFetch("/offers", {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.offers.list.response,
  });
}

export function getOffer(id: string) {
  const validatedId = platformCommercialV2Contracts.offers.detail.params.parse(id);
  return platformApiFetch(`/offers/${validatedId}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.offers.detail.response,
  });
}

export function createOffer(input: CreateOfferInput) {
  const validated = platformCommercialV2Contracts.offers.create.body.parse(input);
  return platformApiFetch("/offers", {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.offers.create.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export function publishOffer(id: string) {
  const validatedId = platformCommercialV2Contracts.offers.publish.params.parse(id);
  return platformApiFetch(`/offers/${validatedId}/publish`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.offers.publish.response,
    method: "POST",
    body: "{}",
  });
}

export function reviseOffer(id: string, idempotencyKey: string) {
  const validatedId = platformCommercialV2Contracts.offers.revise.params.parse(id);
  const body = platformCommercialV2Contracts.offers.revise.body.parse({ idempotencyKey });
  return platformApiFetch(`/offers/${validatedId}/revise`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.offers.revise.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function payOffer(id: string, amount: string, bankReference: string, key: string) {
  const validatedId = platformCommercialV2Contracts.offers.payment.params.parse(id);
  const validated = platformCommercialV2Contracts.offers.payment.body.parse({
    amount,
    currency: "RUB",
    bankReference,
  });
  return platformApiFetch(`/offers/${validatedId}/payment`, {
    responseSchema: platformCommercialV2Contracts.offers.payment.response,
    method: "POST",
    headers: { "Idempotency-Key": key, [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    body: JSON.stringify(validated),
  });
}
