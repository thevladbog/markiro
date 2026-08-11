import { platformApiFetch } from "../../api/client.js";

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
  lines: OfferLine[];
}

export function listOffers(): Promise<Offer[]> {
  return platformApiFetch("/offers");
}
export function createOffer(input: unknown): Promise<Offer> {
  return platformApiFetch("/offers", { method: "POST", body: JSON.stringify(input) });
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
