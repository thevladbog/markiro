import { z } from "zod";

import { platformApiFetch } from "../../api/client.js";
import type { CreateInvoiceInput } from "../documents/types.js";

const moneySchema = z.string().regex(/^\d{1,12}\.\d{2}$/);
const uuidSchema = z.uuid();
const activationPolicySchema = z.enum(["immediate", "after_current", "manual"]);
const invoiceLineInputSchema = z.object({
  kind: z.enum(["plan", "addon", "service"]),
  catalogVersionId: uuidSchema,
  nameRu: z.string().trim().min(1).max(300),
  nameEn: z.string().trim().min(1).max(300),
  quantity: z.number().int().positive(),
  unit: z.string().trim().min(1).max(100),
  agreedUnitPrice: moneySchema,
  vatRateBps: z.number().int().min(0).max(10_000).nullable(),
  vatIncluded: z.boolean(),
  activationPolicy: activationPolicySchema.nullable(),
});
const createInvoiceInputSchema = z.object({
  tenantId: z.string().min(1),
  dueDate: z.string().date().nullable(),
  applicationMode: z.enum(["manual", "automatic"]),
  lines: z.array(invoiceLineInputSchema).min(1).max(100),
});
const invoiceSchema = z.object({
  id: uuidSchema,
  number: z.string().min(1),
  tenantId: z.string().min(1),
  status: z.string().min(1),
  total: moneySchema,
  paidAt: z.string().nullable(),
});

export interface Invoice {
  id: string;
  number: string;
  tenantId: string;
  status: string;
  total: string;
  paidAt: string | null;
}
export function listInvoices(): Promise<{ items: Invoice[] }> {
  return platformApiFetch<unknown>("/invoices").then((response) =>
    z.object({ items: z.array(invoiceSchema) }).parse(response),
  );
}
export function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  const validated = createInvoiceInputSchema.parse(input);
  return platformApiFetch<unknown>("/invoices", {
    method: "POST",
    body: JSON.stringify(validated),
  }).then((response) => invoiceSchema.parse(response));
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
