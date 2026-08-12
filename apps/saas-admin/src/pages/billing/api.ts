import { z } from "zod";

import { platformApiFetch } from "../../api/client.js";
import type { CreateInvoiceInput } from "../documents/documentDraft.js";

const moneySchema = z.string().regex(/^\d{1,12}\.\d{2}$/);
const invoiceSchema = z.object({
  id: z.uuid(),
  number: z.string().min(1),
  tenantId: z.string().min(1),
  status: z.string().min(1),
  total: moneySchema,
  paidAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
const invoiceListSchema = z.object({ items: z.array(invoiceSchema) });
const invoiceLineInputSchema = z.object({
  kind: z.enum(["plan", "addon", "service"]),
  catalogVersionId: z.uuid(),
  nameRu: z.string().trim().min(1).max(300),
  nameEn: z.string().trim().min(1).max(300),
  quantity: z.number().int().positive(),
  unit: z.string().trim().min(1).max(100),
  agreedUnitPrice: moneySchema,
  vatRateBps: z.number().int().min(0).max(10_000).nullable(),
  vatIncluded: z.boolean(),
  activationPolicy: z.enum(["immediate", "after_current", "manual"]).nullable(),
});
const createInvoiceInputSchema = z.object({
  tenantId: z.string().min(1),
  dueDate: z.iso.date().nullable(),
  applicationMode: z.enum(["manual", "automatic"]),
  lines: z.array(invoiceLineInputSchema).min(1).max(100),
});

export type Invoice = z.infer<typeof invoiceSchema>;

export async function listInvoices(): Promise<{ items: Invoice[] }> {
  return invoiceListSchema.parse(await platformApiFetch<unknown>("/invoices"));
}

export async function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  const validated = createInvoiceInputSchema.parse(input);
  return invoiceSchema.parse(
    await platformApiFetch<unknown>("/invoices", {
      method: "POST",
      body: JSON.stringify(validated),
    }),
  );
}

export function issueInvoice(id: string): Promise<Invoice> {
  return platformApiFetch(`/invoices/${id}/issue`, { method: "POST", body: "{}" });
}

export function payInvoice(id: string, amount: string, bankReference: string): Promise<object> {
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

export function renderInvoice(id: string): Promise<object> {
  return platformApiFetch(`/invoices/${id}/document`, { method: "POST", body: "{}" });
}
