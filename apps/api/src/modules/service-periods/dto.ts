import type {
  platformServicePeriodContracts,
  ServiceExcessApprovalPostInput,
  ServiceExcessApprovalWithdrawalInput,
  ServiceUsageCorrectionInput,
  ServiceUsagePostInput,
} from "@markiro/platform-contracts";
import type { z } from "zod";

export type ServicePeriodListQuery = z.output<typeof platformServicePeriodContracts.list.query>;
export type ServicePeriodMutationResult = z.output<
  typeof platformServicePeriodContracts.postUsage.response
>;
export type {
  ServiceExcessApprovalPostInput,
  ServiceExcessApprovalWithdrawalInput,
  ServiceUsageCorrectionInput,
  ServiceUsagePostInput,
};
