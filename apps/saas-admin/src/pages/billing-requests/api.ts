import {
  platformCommercialV2Contracts,
  COMMERCIAL_VERSION_HEADER,
  COMMERCIAL_VERSION,
  type PlatformBillingRequestCommentDto,
  type PlatformBillingRequestLinkDto,
  type PlatformBillingRequestLinkTargetQueryDto,
  type PlatformBillingRequestListQueryDto,
  type PlatformBillingRequestOfferCreateDto,
  type PlatformBillingRequestStatusMutationDto,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type BillingRequestListItem = Awaited<
  ReturnType<typeof listBillingRequests>
>["items"][number];
export type BillingRequestDetail = Awaited<ReturnType<typeof getBillingRequest>>;
export type BillingRequestLinkTarget = Awaited<
  ReturnType<typeof listBillingRequestLinkTargets>
>["items"][number];

export function billingRequestListPath(query: PlatformBillingRequestListQueryDto): string {
  const parsed = platformCommercialV2Contracts.billingRequests.list.query.parse(query);
  const search = new URLSearchParams();
  if (parsed.tenantId) search.set("tenantId", parsed.tenantId);
  if (parsed.status) search.set("status", parsed.status);
  if (parsed.type) search.set("type", parsed.type);
  const suffix = search.toString();
  return `/billing/requests${suffix ? `?${suffix}` : ""}`;
}

export function listBillingRequests(query: PlatformBillingRequestListQueryDto = {}) {
  return platformApiFetch(billingRequestListPath(query), {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingRequests.list.response,
  });
}

export function getBillingRequest(id: string) {
  const requestId = platformCommercialV2Contracts.billingRequests.detail.params.parse(id);
  return platformApiFetch(`/billing/requests/${requestId}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingRequests.detail.response,
  });
}

export function listBillingRequestLinkTargets(
  id: string,
  query: PlatformBillingRequestLinkTargetQueryDto,
  signal?: AbortSignal,
) {
  const requestId = platformCommercialV2Contracts.billingRequests.linkTargets.params.parse(id);
  const parsed = platformCommercialV2Contracts.billingRequests.linkTargets.query.parse(query);
  const search = new URLSearchParams({ type: parsed.type, q: parsed.q });
  return platformApiFetch(`/billing/requests/${requestId}/link-targets?${search}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingRequests.linkTargets.response,
    ...(signal ? { signal } : {}),
  });
}

export function createBillingRequestOffer(id: string, input: PlatformBillingRequestOfferCreateDto) {
  const requestId = platformCommercialV2Contracts.billingRequests.createOffer.params.parse(id);
  const body = platformCommercialV2Contracts.billingRequests.createOffer.body.parse(input);
  return platformApiFetch(`/billing/requests/${requestId}/offer`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingRequests.createOffer.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function commentBillingRequest(id: string, input: PlatformBillingRequestCommentDto) {
  const requestId = platformCommercialV2Contracts.billingRequests.comment.params.parse(id);
  const body = platformCommercialV2Contracts.billingRequests.comment.body.parse(input);
  return platformApiFetch(`/billing/requests/${requestId}/comments`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingRequests.comment.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function transitionBillingRequest(
  id: string,
  input: PlatformBillingRequestStatusMutationDto,
) {
  const requestId = platformCommercialV2Contracts.billingRequests.status.params.parse(id);
  const body = platformCommercialV2Contracts.billingRequests.status.body.parse(input);
  return platformApiFetch(`/billing/requests/${requestId}/status`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingRequests.status.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function linkBillingRequest(id: string, input: PlatformBillingRequestLinkDto) {
  const requestId = platformCommercialV2Contracts.billingRequests.link.params.parse(id);
  const body = platformCommercialV2Contracts.billingRequests.link.body.parse(input);
  return platformApiFetch(`/billing/requests/${requestId}/links`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingRequests.link.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}
