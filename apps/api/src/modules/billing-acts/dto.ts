import {
  platformCommercialContracts,
  type BillingActCancelDto,
  type BillingActCreateDto,
  type BillingActIssueDto,
} from "@markiro/platform-contracts";
import type { z } from "zod";

export const billingActIdSchema = platformCommercialContracts.billingActs.detail.params;
export const billingActListQuerySchema = platformCommercialContracts.billingActs.list.query;
export const billingActCreateSchema = platformCommercialContracts.billingActs.create.body;
export const billingActIssueSchema = platformCommercialContracts.billingActs.issue.body;
export const billingActCancelSchema = platformCommercialContracts.billingActs.cancel.body;

export type BillingActListQueryDto = z.output<typeof billingActListQuerySchema>;
export type { BillingActCancelDto, BillingActCreateDto, BillingActIssueDto };
