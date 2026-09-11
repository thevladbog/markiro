import {
  platformCommercialV2Contracts,
  COMMERCIAL_VERSION_HEADER,
  type ApplyInvoiceInput,
  type BillingPayment,
  type CreateInvoiceV2 as CreateInvoiceInput,
  type Invoice,
  type InvoiceApplicationResult,
  type InvoiceDetailV2 as InvoiceDetail,
  type ManualPaymentInput,
  type PrintDocumentVariant,
} from "@markiro/platform-contracts";

import { platformApiFetch, CURRENT_COMMERCIAL_VERSION } from "../../api/client.js";

export type { ApplyInvoiceInput, Invoice, InvoiceApplicationResult, InvoiceDetail };
export type RecordInvoicePaymentInput = ManualPaymentInput;

export function listInvoices() {
  return platformApiFetch("/invoices", {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.invoices.list.response,
  });
}

export function createInvoice(input: CreateInvoiceInput) {
  const validated = platformCommercialV2Contracts.invoices.create.body.parse(input);
  return platformApiFetch("/invoices", {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.invoices.create.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export function issueInvoice(id: string, printVariant: PrintDocumentVariant = "clean") {
  const validatedId = platformCommercialV2Contracts.invoices.issue.params.parse(id);
  const body = platformCommercialV2Contracts.invoices.issue.body.parse({ printVariant });
  return platformApiFetch(`/invoices/${validatedId}/issue`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.invoices.issue.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getInvoice(id: string) {
  const validatedId = platformCommercialV2Contracts.invoices.detail.params.parse(id);
  return platformApiFetch(`/invoices/${validatedId}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.invoices.detail.response,
  });
}

export function cancelInvoice(id: string) {
  const validatedId = platformCommercialV2Contracts.invoices.cancel.params.parse(id);
  return platformApiFetch(`/invoices/${validatedId}/cancel`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.invoices.cancel.response,
    method: "POST",
    body: "{}",
  });
}

export function deleteInvoiceDraft(id: string) {
  const validatedId = platformCommercialV2Contracts.invoices.delete.params.parse(id);
  return platformApiFetch(`/invoices/${validatedId}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.invoices.delete.response,
    method: "DELETE",
  });
}

export function recordInvoicePayment(
  id: string,
  input: RecordInvoicePaymentInput,
): Promise<BillingPayment> {
  const validatedId = platformCommercialV2Contracts.payments.manual.params.parse(id);
  const validated = platformCommercialV2Contracts.payments.manual.body.parse(input);
  return platformApiFetch(`/payments/invoices/${validatedId}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.payments.manual.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export function applyInvoice(
  id: string,
  input: ApplyInvoiceInput,
): Promise<InvoiceApplicationResult> {
  const validatedId = platformCommercialV2Contracts.invoices.apply.params.parse(id);
  const validated = platformCommercialV2Contracts.invoices.apply.body.parse(input);
  return platformApiFetch(`/invoices/${validatedId}/apply`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.invoices.apply.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export function renderInvoice(id: string, printVariant: PrintDocumentVariant = "clean") {
  const validatedId = platformCommercialV2Contracts.invoices.documents.render.params.parse(id);
  const body = platformCommercialV2Contracts.invoices.documents.render.body.parse({ printVariant });
  return platformApiFetch(`/invoices/${validatedId}/documents`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.invoices.documents.render.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getInvoiceDocumentDownload(invoiceId: string, documentId: string) {
  const validated = platformCommercialV2Contracts.invoices.documents.download.params.parse({
    invoiceId,
    documentId,
  });
  return platformApiFetch(
    `/invoices/${validated.invoiceId}/documents/${validated.documentId}/download`,
    {
      headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
      responseSchema: platformCommercialV2Contracts.invoices.documents.download.response,
    },
  );
}
