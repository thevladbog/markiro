import { useQuery, type QueryClient } from "@tanstack/react-query";

import { ApiRequestError, apiFetch } from "../../api/client.js";

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

export interface TenantBillingAttentionDto {
  count: number;
}

/** Query-key family reserved for tenant billing; actions invalidate only this family. */
export const tenantBillingKeys = {
  all: ["tenant-billing"] as const,
  attention: () => [...tenantBillingKeys.all, "attention"] as const,
  overview: () => [...tenantBillingKeys.all, "overview"] as const,
  subscription: () => [...tenantBillingKeys.all, "subscription"] as const,
  invoices: () => [...tenantBillingKeys.all, "invoices"] as const,
  invoice: (id: string) => [...tenantBillingKeys.invoices(), id] as const,
  documents: () => [...tenantBillingKeys.all, "documents"] as const,
  requests: () => [...tenantBillingKeys.all, "requests"] as const,
  request: (id: string) => [...tenantBillingKeys.requests(), id] as const,
  offers: () => [...tenantBillingKeys.all, "offers"] as const,
};

export type BillingRequestType =
  "renewal" | "capacity_change" | "additional_service" | "documents" | "other";
export type BillingRequestStatus =
  | "new"
  | "under_review"
  | "clarification_required"
  | "offer_prepared"
  | "awaiting_payment"
  | "in_progress"
  | "completed"
  | "cancelled";
export type BillingRequestEventKind =
  | "created"
  | "status_changed"
  | "tenant_reply"
  | "platform_comment"
  | "offer_linked"
  | "offer_accepted"
  | "offer_changes_requested"
  | "invoice_linked"
  | "payment_confirmed"
  | "service_linked"
  | "act_linked";

export interface TenantBillingRequest {
  id: string;
  number: string;
  type: BillingRequestType;
  status: BillingRequestStatus;
  description: string;
  desiredAt: string | null;
  context: { type: string; id: string } | null;
  responsibleSide: "tenant" | "markiro" | "none";
  createdAt: string;
  updatedAt: string;
}

export interface TenantBillingRequestEvent {
  id: string;
  kind: BillingRequestEventKind;
  fromStatus: BillingRequestStatus | null;
  toStatus: BillingRequestStatus | null;
  actorKind: "tenant_user" | "platform_user" | "system";
  message: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface TenantBillingRequestAttachment {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

export interface TenantBillingRequestLink {
  id: string;
  offerId: string | null;
  invoiceId: string | null;
  paymentId: string | null;
  actId: string | null;
  orderedServiceId: string | null;
  subscriptionEventId: string | null;
  createdAt: string;
}

export interface TenantBillingRequestDetail extends TenantBillingRequest {
  events: TenantBillingRequestEvent[];
  attachments: TenantBillingRequestAttachment[];
  links: TenantBillingRequestLink[];
}

export interface BillingRequestFilters {
  status?: BillingRequestStatus;
  type?: BillingRequestType;
}

export interface BillingRequestQuery {
  data: TenantBillingRequestDetail | undefined;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export interface CreateBillingRequestPayload {
  type: BillingRequestType;
  description: string;
  desiredAt?: string;
  context?: { type: string; id: string };
}

export function fetchBillingRequests(filters: BillingRequestFilters = {}) {
  return apiFetch<{ items: TenantBillingRequest[] }>(
    `/billing/requests${queryString({ status: filters.status, type: filters.type })}`,
  );
}

export function useBillingRequests(filters: BillingRequestFilters = {}) {
  return useQuery({
    queryKey: [...tenantBillingKeys.requests(), filters] as const,
    queryFn: () => fetchBillingRequests(filters),
    placeholderData: (previous) => previous,
  });
}

export function useBillingRequest(id: string): BillingRequestQuery {
  return useQuery({
    queryKey: tenantBillingKeys.request(id),
    queryFn: () => apiFetch<TenantBillingRequestDetail>(`/billing/requests/${id}`),
    enabled: Boolean(id),
    staleTime: 5_000,
  });
}

export function createBillingRequest(payload: CreateBillingRequestPayload, idempotencyKey: string) {
  return apiFetch<TenantBillingRequestDetail>("/billing/requests", {
    method: "POST",
    body: JSON.stringify({ ...payload, idempotencyKey }),
  });
}

export function uploadBillingRequestAttachment(requestId: string, file: File) {
  const body = new FormData();
  body.append("file", file);
  return apiFetch<TenantBillingRequestAttachment>(`/billing/requests/${requestId}/attachments`, {
    method: "POST",
    body,
  });
}

export function isRetryableApiError(cause: unknown): boolean {
  return !(cause instanceof ApiRequestError) || cause.status >= 500;
}

export function mergeBillingRequestAttachment(
  queryClient: QueryClient,
  requestId: string,
  attachment: TenantBillingRequestAttachment,
): void {
  queryClient.setQueryData<TenantBillingRequestDetail>(
    tenantBillingKeys.request(requestId),
    (current) =>
      current
        ? {
            ...current,
            attachments: [
              ...current.attachments.filter((item) => item.id !== attachment.id),
              attachment,
            ].sort(
              (left, right) =>
                Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
                left.id.localeCompare(right.id),
            ),
          }
        : current,
  );
}

export function downloadRequestAttachment(requestId: string, attachmentId: string) {
  return apiFetch<{ url: string }>(
    `/billing/requests/${requestId}/attachments/${attachmentId}/download`,
  );
}

export function replyToBillingRequest(requestId: string, message: string, idempotencyKey: string) {
  return apiFetch<TenantBillingRequestEvent>(`/billing/requests/${requestId}/replies`, {
    method: "POST",
    body: JSON.stringify({ message, idempotencyKey }),
  });
}

export async function invalidateTenantBillingRequests(
  queryClient: QueryClient,
  _requestId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: tenantBillingKeys.requests() }),
    queryClient.invalidateQueries({ queryKey: tenantBillingKeys.overview() }),
  ]);
}

export function fetchBillingOverview(): Promise<TenantBillingOverviewDto> {
  return apiFetch<TenantBillingOverviewDto>("/billing/overview");
}

export function fetchBillingAttention(): Promise<TenantBillingAttentionDto> {
  return apiFetch<TenantBillingAttentionDto>("/billing/attention");
}

export function fetchBillingSubscription(): Promise<TenantSubscriptionBillingDto> {
  return apiFetch<TenantSubscriptionBillingDto>("/billing/subscription");
}

export function useBillingOverview() {
  return useQuery({ queryKey: tenantBillingKeys.overview(), queryFn: fetchBillingOverview });
}

export function useBillingAttention(enabled = true) {
  return useQuery({
    queryKey: tenantBillingKeys.attention(),
    queryFn: fetchBillingAttention,
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

export function useBillingSubscription() {
  return useQuery({
    queryKey: tenantBillingKeys.subscription(),
    queryFn: fetchBillingSubscription,
  });
}

/** Shared post-action refresh boundary for the requests, offers, and document tasks. */
export function invalidateTenantBilling(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: tenantBillingKeys.all });
}

export type TenantInvoiceStatus =
  "draft" | "issued" | "overdue" | "partially_paid" | "paid" | "cancelled";

export interface InvoiceFilters {
  status?: TenantInvoiceStatus;
  from?: string;
  to?: string;
}

export interface TenantInvoice {
  id: string;
  number: string;
  issueDate: string | null;
  dueDate: string | null;
  status: TenantInvoiceStatus;
  total: string;
  currency: string;
  paymentSummary: {
    confirmedAmount: string;
    remainingAmount: string;
    status: "issued" | "partially_paid" | "paid";
  } | null;
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
    contentType: string | null;
    byteSize: number | null;
    createdAt: string;
  }>;
  payments: Array<{ id: string; amount: string; currency: "RUB"; paidAt: string }>;
  request: { id: string; number: string; status: string } | null;
}

function queryString(filters: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function fetchInvoices(filters: InvoiceFilters = {}) {
  return apiFetch<{ items: TenantInvoice[] }>(
    `/billing/invoices${queryString({ status: filters.status, from: filters.from, to: filters.to })}`,
  );
}

export function useInvoices(filters: InvoiceFilters = {}) {
  return useQuery({
    queryKey: [...tenantBillingKeys.invoices(), filters] as const,
    queryFn: () => fetchInvoices(filters),
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

export interface DocumentFilters {
  type?: "offer" | "act";
  from?: string;
  to?: string;
}

export interface TenantDocument {
  id: string;
  type: "offer" | "act";
  entityId: string;
  revision: number;
  format: "pdf" | "html";
  status: "pending" | "ready" | "failed";
  contentType: string | null;
  byteSize: number | null;
  createdAt: string;
}

export type TenantRenderedDocument = Omit<TenantDocument, "type" | "entityId">;

export function fetchDocuments(filters: DocumentFilters = {}) {
  return apiFetch<{ items: TenantDocument[] }>(
    `/billing/documents${queryString({ type: filters.type, from: filters.from, to: filters.to })}`,
  );
}

export function useDocuments(filters: DocumentFilters = {}) {
  return useQuery({
    queryKey: [...tenantBillingKeys.documents(), filters] as const,
    queryFn: () => fetchDocuments(filters),
  });
}

export function downloadOfferDocument(offerId: string, documentId: string) {
  return apiFetch<{ url: string }>(`/billing/offers/${offerId}/documents/${documentId}/download`);
}

export function downloadActDocument(actId: string, documentId: string) {
  return apiFetch<{ url: string }>(`/billing/acts/${actId}/documents/${documentId}/download`);
}

export interface TenantOffer {
  id: string;
  number: string | null;
  status: "draft" | "published" | "superseded" | "paid" | "cancelled" | "expired";
  total: string;
  expiresAt: string | null;
  publishedAt: string | null;
  paidAt: string | null;
  termsMarkdown: string | null;
  isCurrent: boolean;
  actionable: boolean;
  latestDecision: {
    decision: "accepted" | "changes_requested";
    message: string | null;
    createdAt: string;
  } | null;
  lines: Array<{
    id: string;
    position: number;
    kind: "plan" | "addon" | "service";
    nameRu: string;
    quantity: number;
    unit: string;
    agreedUnitPrice: string;
    lineTotal: string;
  }>;
  documents: TenantRenderedDocument[];
  request: { id: string; number: string; status: string } | null;
}

export interface OfferDecision {
  id: string;
  offerId: string;
  decision: "accepted" | "changes_requested";
  message: string | null;
  createdAt: string;
}

export function useOffer(id: string) {
  return useQuery({
    queryKey: [...tenantBillingKeys.offers(), id] as const,
    queryFn: () => apiFetch<TenantOffer>(`/billing/offers/${id}`),
    enabled: Boolean(id),
  });
}

export function acceptOffer(id: string, idempotencyKey: string) {
  return apiFetch<OfferDecision>(`/billing/offers/${id}/accept`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey }),
  });
}

export function requestOfferChanges(id: string, message: string, idempotencyKey: string) {
  return apiFetch<OfferDecision>(`/billing/offers/${id}/change-request`, {
    method: "POST",
    body: JSON.stringify({ message, idempotencyKey }),
  });
}
