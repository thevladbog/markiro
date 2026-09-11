import {
  platformCommercialV2Contracts,
  COMMERCIAL_VERSION_HEADER,
  COMMERCIAL_VERSION,
  type CreateOfferV2 as CreateOfferInput,
  platformCommercialContracts,
  platformOfferWorkspaceContracts,
  platformOfferWorkspaceV2Contracts,
  type OfferRegistryQuery,
  type Offer as SharedOffer,
  type OfferDetailV2 as OfferDetail,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type Offer = SharedOffer;
export type OfferLine = OfferDetail["lines"][number];
export type { OfferDetail };

export function listOfferRegistry(query: OfferRegistryQuery) {
  const validated = platformOfferWorkspaceContracts.registry.query.parse(query);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(validated)) params.set(key, String(value));
  return platformApiFetch(`/offers/registry?${params}`, {
    responseSchema: platformOfferWorkspaceContracts.registry.response,
  });
}
export function getOfferWorkspace(id: string) {
  const validated = platformOfferWorkspaceContracts.workspace.params.parse(id);
  return platformApiFetch(`/offers/${validated}/workspace`, {
    responseSchema: platformOfferWorkspaceV2Contracts.workspace.response,
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
  });
}
export function previewOffer(id: string) {
  const validated = platformOfferWorkspaceContracts.preview.params.parse(id);
  return platformApiFetch(`/offers/${validated}/preview`, {
    responseSchema: platformOfferWorkspaceContracts.preview.response,
    cache: "no-store",
  });
}
export function cancelOffer(id: string) {
  const validated = platformCommercialV2Contracts.offers.cancel.params.parse(id);
  return platformApiFetch(`/offers/${validated}/cancel`, {
    responseSchema: platformCommercialV2Contracts.offers.cancel.response,
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    method: "POST",
    body: "{}",
  });
}
export function listOfferDocuments(id: string) {
  const validated = platformCommercialContracts.offers.documents.list.params.parse(id);
  return platformApiFetch(`/offers/${validated}/documents`, {
    responseSchema: platformCommercialContracts.offers.documents.list.response,
  });
}
export function renderOfferDocuments(id: string, printVariant: "clean" | "signed") {
  const contract = platformCommercialContracts.offers.documents.render;
  const validated = contract.params.parse(id);
  return platformApiFetch(`/offers/${validated}/documents`, {
    responseSchema: contract.response,
    method: "POST",
    body: JSON.stringify(contract.body.parse({ printVariant })),
  });
}
export function downloadOfferDocument(offerId: string, documentId: string) {
  const contract = platformCommercialContracts.offers.documents.download;
  const validated = contract.params.parse({ offerId, documentId });
  return platformApiFetch(
    `/offers/${validated.offerId}/documents/${validated.documentId}/download`,
    { responseSchema: contract.response },
  );
}

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

export function publishOffer(id: string, previewFingerprint?: string) {
  const validatedId = platformCommercialV2Contracts.offers.publish.params.parse(id);
  return platformApiFetch(`/offers/${validatedId}/publish`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.offers.publish.response,
    method: "POST",
    body: JSON.stringify(
      platformCommercialContracts.offers.publish.body.parse({ previewFingerprint }),
    ),
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
