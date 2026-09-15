import {
  platformServicePeriodContracts,
  type ServiceExcessApprovalPostInput,
  type ServiceExcessApprovalWithdrawalInput,
  type ServiceUsageCorrectionInput,
  type ServiceUsagePostInput,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type ServicePeriodListQuery = Parameters<
  typeof platformServicePeriodContracts.list.query.parse
>[0];
export type ServicePeriodList = Awaited<ReturnType<typeof listServicePeriods>>;
export type ServicePeriodDetail = Awaited<ReturnType<typeof getServicePeriod>>;

export function listServicePeriods(input: unknown = {}) {
  const query = platformServicePeriodContracts.list.query.parse(input);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  return platformApiFetch(`/service-periods?${params}`, {
    responseSchema: platformServicePeriodContracts.list.response,
  });
}

export function getServicePeriod(id: string) {
  const value = platformServicePeriodContracts.detail.params.parse({ id });
  return platformApiFetch(`/service-periods/${value.id}`, {
    responseSchema: platformServicePeriodContracts.detail.response,
  });
}

export function postServiceUsage(id: string, input: ServiceUsagePostInput) {
  const body = platformServicePeriodContracts.postUsage.body.parse(input);
  return platformApiFetch(`/service-periods/${id}/usage`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformServicePeriodContracts.postUsage.response,
  });
}

export function correctServiceUsage(
  id: string,
  entryId: string,
  input: ServiceUsageCorrectionInput,
) {
  const body = platformServicePeriodContracts.correctUsage.body.parse(input);
  return platformApiFetch(`/service-periods/${id}/usage/${entryId}/corrections`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformServicePeriodContracts.correctUsage.response,
  });
}

export function addServiceApproval(id: string, input: ServiceExcessApprovalPostInput) {
  const body = platformServicePeriodContracts.addApproval.body.parse(input);
  return platformApiFetch(`/service-periods/${id}/approvals`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformServicePeriodContracts.addApproval.response,
  });
}

export function withdrawServiceApproval(
  id: string,
  approvalId: string,
  input: ServiceExcessApprovalWithdrawalInput,
) {
  const body = platformServicePeriodContracts.withdrawApproval.body.parse(input);
  return platformApiFetch(`/service-periods/${id}/approvals/${approvalId}/withdrawals`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformServicePeriodContracts.withdrawApproval.response,
  });
}
