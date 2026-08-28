import { useQuery, type QueryClient } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

export type BillingAccess = "managed" | "read_only" | "unmanaged";
export type BillingLimitKey = "lines" | "stations" | "kiosks" | "cabinetUsers";

export interface TenantBillingSubscription {
  id: string;
  planVersionId: string;
  status:
    | "pending_activation"
    | "trial"
    | "active"
    | "scheduled"
    | "expired"
    | "cancelled"
    | "superseded";
  startsAt: string | null;
  endsAt: string | null;
  planName: string | null;
  billingPeriod: "month" | "year" | null;
  price: string | null;
}

export interface TenantBillingLimitPresentation {
  used: number;
  assigned: number | null;
  remaining: number | null;
  state: "normal" | "approaching" | "reached" | "exceeded";
}

export interface TenantSubscriptionBillingDto {
  subscription: TenantBillingSubscription | null;
  scheduledSubscription: TenantBillingSubscription | null;
  access: BillingAccess;
  limits: Record<BillingLimitKey, number | null> & {
    labelEditor: boolean;
    publicApi: boolean;
    pallets: boolean;
  };
  usage: Record<BillingLimitKey, number>;
  limitPresentation: Record<BillingLimitKey, TenantBillingLimitPresentation>;
  addons: Array<{
    id: string;
    catalogVersionId: string;
    name: string;
    quantity: number;
    status: "scheduled" | "active" | "expired" | "revoked";
    startsAt: string | null;
    endsAt: string | null;
  }>;
  services: Array<{
    id: string;
    name: string;
    quantity: number;
    unit: string;
    status: "ordered" | "in_progress" | "completed" | "cancelled";
    orderedAt: string;
  }>;
}

export interface TenantBillingOverviewDto extends TenantSubscriptionBillingDto {
  actionableOffer: { id: string; number: string | null; total: string } | null;
  recentOperations: Array<{
    id: string;
    kind: "invoice" | "offer" | "request" | "service" | "act" | "payment";
    status:
      | "draft"
      | "issued"
      | "overdue"
      | "partially_paid"
      | "paid"
      | "cancelled"
      | "published"
      | "expired"
      | "superseded"
      | "new"
      | "under_review"
      | "clarification_required"
      | "offer_prepared"
      | "awaiting_payment"
      | "in_progress"
      | "completed"
      | "ordered"
      | "confirmed";
    occurredAt: string;
    label: string;
  }>;
  activeRequest: {
    id: string;
    number: string;
    status:
      | "new"
      | "under_review"
      | "clarification_required"
      | "offer_prepared"
      | "awaiting_payment"
      | "in_progress"
      | "completed"
      | "cancelled";
  } | null;
  attentionCount: number;
}

/** Query-key family reserved for tenant billing; actions invalidate only this family. */
export const tenantBillingKeys = {
  all: ["tenant-billing"] as const,
  overview: () => [...tenantBillingKeys.all, "overview"] as const,
  subscription: () => [...tenantBillingKeys.all, "subscription"] as const,
  invoices: () => [...tenantBillingKeys.all, "invoices"] as const,
  invoice: (id: string) => [...tenantBillingKeys.invoices(), id] as const,
  documents: () => [...tenantBillingKeys.all, "documents"] as const,
  requests: () => [...tenantBillingKeys.all, "requests"] as const,
  offers: () => [...tenantBillingKeys.all, "offers"] as const,
};

export function fetchBillingOverview(): Promise<TenantBillingOverviewDto> {
  return apiFetch<TenantBillingOverviewDto>("/billing/overview");
}

export function fetchBillingSubscription(): Promise<TenantSubscriptionBillingDto> {
  return apiFetch<TenantSubscriptionBillingDto>("/billing/subscription");
}

export function useBillingOverview() {
  return useQuery({ queryKey: tenantBillingKeys.overview(), queryFn: fetchBillingOverview });
}

export function useBillingSubscription() {
  return useQuery({
    queryKey: tenantBillingKeys.subscription(),
    queryFn: fetchBillingSubscription,
  });
}

/** Shared post-action refresh boundary for the requests, offers, and document tasks. */
export function invalidateTenantBilling(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: tenantBillingKeys.overview() }),
    queryClient.invalidateQueries({ queryKey: tenantBillingKeys.subscription() }),
    queryClient.invalidateQueries({ queryKey: tenantBillingKeys.documents() }),
    queryClient.invalidateQueries({ queryKey: tenantBillingKeys.requests() }),
    queryClient.invalidateQueries({ queryKey: tenantBillingKeys.offers() }),
  ]).then(() => undefined);
}

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
    queryKey: tenantBillingKeys.invoices(),
    queryFn: () => apiFetch<{ items: TenantInvoice[] }>("/billing/invoices"),
  });
}
export function useInvoice(id: string) {
  return useQuery({
    queryKey: tenantBillingKeys.invoice(id),
    queryFn: () => apiFetch<TenantInvoiceDetail>(`/billing/invoices/${id}`),
    enabled: Boolean(id),
  });
}
export function downloadInvoice(id: string, documentId: string) {
  return apiFetch<{ url: string }>(`/billing/invoices/${id}/documents/${documentId}/download`);
}
