import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../api/client.js";

export interface TenantInvoice {
  id: string;
  number: string;
  issueDate: string | null;
  dueDate: string | null;
  status: string;
  total: string;
  currency: string;
}
export interface TenantInvoiceDetail extends TenantInvoice {
  subtotal: string;
  vatTotal: string;
  lines: Array<{
    position: number;
    nameRu: string;
    unit: string;
    quantity: number;
    agreedUnitPrice: string;
    lineTotal: string;
  }>;
  documents: Array<{
    id: string;
    revision: number;
    format: string;
    status: string;
    byteSize: number | null;
  }>;
}
export function useInvoices() {
  return useQuery({
    queryKey: ["billing", "invoices"],
    queryFn: () => apiFetch<{ items: TenantInvoice[] }>("/billing/invoices"),
  });
}
export function useInvoice(id: string) {
  return useQuery({
    queryKey: ["billing", "invoice", id],
    queryFn: () => apiFetch<TenantInvoiceDetail>(`/billing/invoices/${id}`),
    enabled: Boolean(id),
  });
}
export function downloadInvoice(id: string, documentId: string) {
  return apiFetch<{ url: string }>(`/billing/invoices/${id}/documents/${documentId}/download`);
}
