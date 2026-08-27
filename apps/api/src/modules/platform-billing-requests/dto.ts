import {
  platformCommercialContracts,
  type PlatformBillingRequestCommentDto,
  type PlatformBillingRequestLinkDto,
  type PlatformBillingRequestListQueryDto,
  type PlatformBillingRequestStatusMutationDto,
} from "@markiro/platform-contracts";

export const platformBillingRequestIdSchema =
  platformCommercialContracts.billingRequests.detail.params;
export const platformBillingRequestListQuerySchema =
  platformCommercialContracts.billingRequests.list.query;
export const platformBillingRequestCommentSchema =
  platformCommercialContracts.billingRequests.comment.body;
export const platformBillingRequestStatusSchema =
  platformCommercialContracts.billingRequests.status.body;
export const platformBillingRequestLinkSchema =
  platformCommercialContracts.billingRequests.link.body;

export type {
  PlatformBillingRequestCommentDto,
  PlatformBillingRequestLinkDto,
  PlatformBillingRequestListQueryDto,
  PlatformBillingRequestStatusMutationDto,
};
