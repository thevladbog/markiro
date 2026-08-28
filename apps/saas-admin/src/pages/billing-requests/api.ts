import {
  platformCommercialContracts,
  type PlatformBillingRequestCommentDto,
  type PlatformBillingRequestLinkDto,
  type PlatformBillingRequestListQueryDto,
  type PlatformBillingRequestOfferCreateDto,
  type PlatformBillingRequestStatusMutationDto,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type BillingRequestListItem = Awaited<
  ReturnType<typeof listBillingRequests>
>["items"][number];
export type BillingRequestDetail = Awaited<ReturnType<typeof getBillingRequest>>;

export function billingRequestListPath(query: PlatformBillingRequestListQueryDto): string {
  const parsed = platformCommercialContracts.billingRequests.list.query.parse(query);
  const search = new URLSearchParams();
  if (parsed.tenantId) search.set("tenantId", parsed.tenantId);
  if (parsed.status) search.set("status", parsed.status);
  if (parsed.type) search.set("type", parsed.type);
  const suffix = search.toString();
  return `/billing/requests${suffix ? `?${suffix}` : ""}`;
}

export function listBillingRequests(query: PlatformBillingRequestListQueryDto = {}) {
  return platformApiFetch(billingRequestListPath(query), {
    responseSchema: platformCommercialContracts.billingRequests.list.response,
  });
}

export function getBillingRequest(id: string) {
  const requestId = platformCommercialContracts.billingRequests.detail.params.parse(id);
  return platformApiFetch(`/billing/requests/${requestId}`, {
    responseSchema: platformCommercialContracts.billingRequests.detail.response,
  });
}

export function createBillingRequestOffer(id: string, input: PlatformBillingRequestOfferCreateDto) {
  const requestId = platformCommercialContracts.billingRequests.createOffer.params.parse(id);
  const body = platformCommercialContracts.billingRequests.createOffer.body.parse(input);
  return platformApiFetch(`/billing/requests/${requestId}/offer`, {
    responseSchema: platformCommercialContracts.billingRequests.createOffer.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function commentBillingRequest(id: string, input: PlatformBillingRequestCommentDto) {
  const requestId = platformCommercialContracts.billingRequests.comment.params.parse(id);
  const body = platformCommercialContracts.billingRequests.comment.body.parse(input);
  return platformApiFetch(`/billing/requests/${requestId}/comments`, {
    responseSchema: platformCommercialContracts.billingRequests.comment.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function transitionBillingRequest(
  id: string,
  input: PlatformBillingRequestStatusMutationDto,
) {
  const requestId = platformCommercialContracts.billingRequests.status.params.parse(id);
  const body = platformCommercialContracts.billingRequests.status.body.parse(input);
  return platformApiFetch(`/billing/requests/${requestId}/status`, {
    responseSchema: platformCommercialContracts.billingRequests.status.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function linkBillingRequest(id: string, input: PlatformBillingRequestLinkDto) {
  const requestId = platformCommercialContracts.billingRequests.link.params.parse(id);
  const body = platformCommercialContracts.billingRequests.link.body.parse(input);
  return platformApiFetch(`/billing/requests/${requestId}/links`, {
    responseSchema: platformCommercialContracts.billingRequests.link.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}
