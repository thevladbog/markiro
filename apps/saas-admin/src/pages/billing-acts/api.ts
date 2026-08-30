import {
  platformCommercialContracts,
  type BillingAct,
  type BillingActCreateDto,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export function createBillingAct(input: BillingActCreateDto) {
  const body = platformCommercialContracts.billingActs.create.body.parse(input);
  return platformApiFetch("/billing/acts", {
    responseSchema: platformCommercialContracts.billingActs.create.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getBillingAct(id: string) {
  const actId = platformCommercialContracts.billingActs.detail.params.parse(id);
  return platformApiFetch(`/billing/acts/${actId}`, {
    responseSchema: platformCommercialContracts.billingActs.detail.response,
  });
}

export function listBillingActs() {
  return platformApiFetch("/billing/acts", {
    responseSchema: platformCommercialContracts.billingActs.list.response,
  });
}

export function issueBillingAct(id: string, idempotencyKey: string): Promise<BillingAct> {
  const actId = platformCommercialContracts.billingActs.issue.params.parse(id);
  const body = platformCommercialContracts.billingActs.issue.body.parse({ idempotencyKey });
  return platformApiFetch(`/billing/acts/${actId}/issue`, {
    responseSchema: platformCommercialContracts.billingActs.issue.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}
