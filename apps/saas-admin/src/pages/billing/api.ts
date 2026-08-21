import { z } from "zod";

import { platformApiFetch } from "../../api/client.js";
import type { CreateInvoiceInput } from "../documents/types.js";

const moneySchema = z.string().regex(/^\d{1,12}\.\d{2}$/);
const uuidSchema = z.uuid();
const activationPolicySchema = z.enum(["immediate", "after_current", "manual"]);
const invoiceLineInputSchema = z.object({
  kind: z.enum(["plan", "addon", "service", "custom"]),
  catalogVersionId: uuidSchema.nullable(),
  nameRu: z.string().trim().min(1).max(300),
  nameEn: z.string().trim().min(1).max(300),
  descriptionRu: z.string().nullable().optional(),
  descriptionEn: z.string().nullable().optional(),
  quantity: z.number().int().positive(),
  unit: z.string().trim().min(1).max(100),
  catalogUnitPrice: moneySchema.nullable().optional(),
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
const invoiceLineSchema = z.object({
  id: uuidSchema,
  position: z.number().int().positive(),
  kind: z.enum(["plan", "addon", "service", "custom"]),
  catalogVersionId: uuidSchema.nullable(),
  nameRu: z.string(),
  nameEn: z.string(),
  quantity: z.number().int().positive(),
  unit: z.string(),
  agreedUnitPrice: moneySchema,
  lineTotal: moneySchema,
  activationPolicy: activationPolicySchema.nullable(),
});
const applicationEventSchema = z.object({
  id: uuidSchema,
  invoiceLineId: uuidSchema,
  attempt: z.number().int().positive(),
  status: z.enum(["pending", "applied", "failed"]),
  kind: z.enum(["plan", "addon", "service", "custom"]),
  source: z.string(),
  afterSnapshot: z.unknown().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
});
const paymentSchema = z.object({
  id: uuidSchema,
  paidAt: z.string(),
  amount: moneySchema,
  currency: z.literal("RUB"),
  bankReference: z.string(),
});
const invoiceDetailSchema = invoiceSchema.extend({
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  subtotal: moneySchema,
  vatTotal: moneySchema,
  currency: z.literal("RUB"),
  applicationMode: z.enum(["manual", "automatic"]),
  lines: z.array(invoiceLineSchema),
  documents: z.array(
    z.object({
      id: uuidSchema,
      revision: z.number().int().positive(),
      format: z.string(),
      status: z.string(),
      errorCode: z.string().nullable().optional(),
    }),
  ),
  payment: paymentSchema.nullable(),
  application: z.object({
    status: z.enum(["not_paid", "pending", "partial_failure", "applied"]),
    latestByLine: z.array(applicationEventSchema),
    attempts: z.array(applicationEventSchema),
  }),
});
const paymentInputSchema = z.object({
  amount: moneySchema,
  paidAt: z.string().datetime(),
  bankReference: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(8).max(200),
});
const applyInputSchema = z.object({
  reason: z.string().trim().min(1).max(1_000),
  lines: z
    .array(
      z.object({
        lineId: uuidSchema,
        activationPolicy: z.enum(["immediate", "after_current"]).optional(),
      }),
    )
    .min(1),
});
const applicationResultSchema = z.object({
  invoiceId: uuidSchema,
  status: z.enum(["pending", "applied", "partial_failure"]),
  results: z.array(
    z.object({
      lineId: uuidSchema,
      attempt: z.number().int().positive(),
      status: z.enum(["pending", "applied", "failed", "skipped"]),
      kind: z.enum(["plan", "addon", "service", "custom"]),
      result: z.unknown().nullable(),
      errorCode: z.string().nullable(),
    }),
  ),
});

export interface Invoice {
  id: string;
  number: string;
  tenantId: string;
  status: string;
  total: string;
  paidAt: string | null;
}
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;
export type RecordInvoicePaymentInput = z.infer<typeof paymentInputSchema>;
export type ApplyInvoiceInput = z.infer<typeof applyInputSchema>;
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
  return platformApiFetch<unknown>(`/invoices/${id}/issue`, {
    method: "POST",
    body: "{}",
  }).then((response) => invoiceSchema.parse(response));
}
export function getInvoice(id: string): Promise<InvoiceDetail> {
  return platformApiFetch<unknown>(`/invoices/${id}`).then((response) =>
    invoiceDetailSchema.parse(response),
  );
}
export function recordInvoicePayment(
  id: string,
  input: RecordInvoicePaymentInput,
): Promise<z.infer<typeof paymentSchema>> {
  const validated = paymentInputSchema.parse(input);
  return platformApiFetch<unknown>(`/payments/invoices/${id}`, {
    method: "POST",
    body: JSON.stringify(validated),
  }).then((response) => paymentSchema.parse(response));
}
export function applyInvoice(
  id: string,
  input: ApplyInvoiceInput,
): Promise<z.infer<typeof applicationResultSchema>> {
  const validated = applyInputSchema.parse(input);
  return platformApiFetch<unknown>(`/invoices/${id}/apply`, {
    method: "POST",
    body: JSON.stringify(validated),
  }).then((response) => applicationResultSchema.parse(response));
}
export function renderInvoice(id: string): Promise<unknown> {
  return platformApiFetch(`/invoices/${id}/document`, { method: "POST", body: "{}" });
}
