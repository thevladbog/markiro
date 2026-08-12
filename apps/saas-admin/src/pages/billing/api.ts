import { platformApiFetch } from "../../api/client.js";

export interface Invoice {
  id: string;
  number: string;
  tenantId: string;
  status: string;
  total: string;
  paidAt: string | null;
}
export function listInvoices(): Promise<{ items: Invoice[] }> {
  return platformApiFetch("/invoices");
}
export function createInvoice(input: unknown): Promise<Invoice> {
  return platformApiFetch("/invoices", { method: "POST", body: JSON.stringify(input) });
}
export function issueInvoice(id: string): Promise<Invoice> {
  return platformApiFetch(`/invoices/${id}/issue`, { method: "POST", body: "{}" });
}
export function payInvoice(id: string, amount: string, bankReference: string): Promise<unknown> {
  return platformApiFetch(`/payments/invoices/${id}`, {
    method: "POST",
    body: JSON.stringify({
      amount,
      paidAt: new Date().toISOString(),
      bankReference,
      idempotencyKey: crypto.randomUUID(),
    }),
  });
}
export function renderInvoice(id: string): Promise<unknown> {
  return platformApiFetch(`/invoices/${id}/document`, { method: "POST", body: "{}" });
}
