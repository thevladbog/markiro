import {
  platformCommercialV2Contracts,
  COMMERCIAL_VERSION_HEADER,
  COMMERCIAL_VERSION,
  type BankAccountArchiveInput,
  type BankAccountInput,
  type OperatorBillingProfileInputV2 as OperatorBillingProfileInput,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export function getOperatorBillingProfile() {
  return platformApiFetch("/billing/operator-profile", {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingProfiles.operator.get.response,
  });
}

export function setOperatorBillingProfile(input: OperatorBillingProfileInput) {
  return platformApiFetch("/billing/operator-profile", {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingProfiles.operator.set.response,
    method: "PUT",
    body: JSON.stringify(
      platformCommercialV2Contracts.billingProfiles.operator.set.body.parse(input),
    ),
  });
}

export function listOperatorBankAccounts() {
  return platformApiFetch("/billing/operator/accounts", {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingAccounts.operator.list.response,
  });
}

export function createOperatorBankAccount(input: BankAccountInput) {
  return platformApiFetch("/billing/operator/accounts", {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingAccounts.operator.create.response,
    method: "POST",
    body: JSON.stringify(
      platformCommercialV2Contracts.billingAccounts.operator.create.body.parse(input),
    ),
  });
}

export function setOperatorDefaultBankAccount(accountId: string) {
  return platformApiFetch(`/billing/operator/accounts/${accountId}/default`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingAccounts.operator.setDefault.response,
    method: "PATCH",
  });
}

export function archiveOperatorBankAccount(accountId: string, input: BankAccountArchiveInput = {}) {
  return platformApiFetch(`/billing/operator/accounts/${accountId}/archive`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCommercialV2Contracts.billingAccounts.operator.archive.response,
    method: "POST",
    body: JSON.stringify(
      platformCommercialV2Contracts.billingAccounts.operator.archive.body.parse(input),
    ),
  });
}
