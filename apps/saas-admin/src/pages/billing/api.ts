import {
  platformCommercialContracts,
  type ApplyInvoiceInput,
  type BillingPayment,
  type CreateInvoiceInput,
  type Invoice,
  type InvoiceApplicationResult,
  type InvoiceDetail,
  type ManualPaymentInput,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type { ApplyInvoiceInput, Invoice, InvoiceApplicationResult, InvoiceDetail };
export type RecordInvoicePaymentInput = ManualPaymentInput;

export function listInvoices() {
  return platformApiFetch("/invoices", platformCommercialContracts.invoices.list.response);
}

export function createInvoice(input: CreateInvoiceInput) {
  const validated = platformCommercialContracts.invoices.create.body.parse(input);
  return platformApiFetch("/invoices", platformCommercialContracts.invoices.create.response, {
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export function issueInvoice(id: string) {
  const validatedId = platformCommercialContracts.invoices.issue.params.parse(id);
  return platformApiFetch(
    `/invoices/${validatedId}/issue`,
    platformCommercialContracts.invoices.issue.response,
    { method: "POST", body: "{}" },
  );
}

export function getInvoice(id: string) {
  const validatedId = platformCommercialContracts.invoices.detail.params.parse(id);
  return platformApiFetch(
    `/invoices/${validatedId}`,
    platformCommercialContracts.invoices.detail.response,
  );
}

export function recordInvoicePayment(
  id: string,
  input: RecordInvoicePaymentInput,
): Promise<BillingPayment> {
  const validatedId = platformCommercialContracts.payments.manual.params.parse(id);
  const validated = platformCommercialContracts.payments.manual.body.parse(input);
  return platformApiFetch(
    `/payments/invoices/${validatedId}`,
    platformCommercialContracts.payments.manual.response,
    {
      method: "POST",
      body: JSON.stringify(validated),
    },
  );
}

export function applyInvoice(
  id: string,
  input: ApplyInvoiceInput,
): Promise<InvoiceApplicationResult> {
  const validatedId = platformCommercialContracts.invoices.apply.params.parse(id);
  const validated = platformCommercialContracts.invoices.apply.body.parse(input);
  return platformApiFetch(
    `/invoices/${validatedId}/apply`,
    platformCommercialContracts.invoices.apply.response,
    {
      method: "POST",
      body: JSON.stringify(validated),
    },
  );
}

export function renderInvoice(id: string) {
  const validatedId = platformCommercialContracts.invoices.document.params.parse(id);
  return platformApiFetch(
    `/invoices/${validatedId}/document`,
    platformCommercialContracts.invoices.document.response,
    { method: "POST", body: "{}" },
  );
}
