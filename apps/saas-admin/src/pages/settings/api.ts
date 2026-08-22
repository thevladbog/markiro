import {
  platformCommercialContracts,
  type BankAccountArchiveInput,
  type BankAccountInput,
  type OperatorBillingProfileInput,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export function getOperatorBillingProfile() {
  return platformApiFetch("/billing/operator-profile", {
    responseSchema: platformCommercialContracts.billingProfiles.operator.get.response,
  });
}

export function setOperatorBillingProfile(input: OperatorBillingProfileInput) {
  return platformApiFetch("/billing/operator-profile", {
    responseSchema: platformCommercialContracts.billingProfiles.operator.set.response,
    method: "PUT",
    body: JSON.stringify(
      platformCommercialContracts.billingProfiles.operator.set.body.parse(input),
    ),
  });
}

export function listOperatorBankAccounts() {
  return platformApiFetch("/billing/operator/accounts", {
    responseSchema: platformCommercialContracts.billingAccounts.operator.list.response,
  });
}

export function createOperatorBankAccount(input: BankAccountInput) {
  return platformApiFetch("/billing/operator/accounts", {
    responseSchema: platformCommercialContracts.billingAccounts.operator.create.response,
    method: "POST",
    body: JSON.stringify(
      platformCommercialContracts.billingAccounts.operator.create.body.parse(input),
    ),
  });
}

export function setOperatorDefaultBankAccount(accountId: string) {
  return platformApiFetch(`/billing/operator/accounts/${accountId}/default`, {
    responseSchema: platformCommercialContracts.billingAccounts.operator.setDefault.response,
    method: "PATCH",
  });
}

export function archiveOperatorBankAccount(accountId: string, input: BankAccountArchiveInput = {}) {
  return platformApiFetch(`/billing/operator/accounts/${accountId}/archive`, {
    responseSchema: platformCommercialContracts.billingAccounts.operator.archive.response,
    method: "POST",
    body: JSON.stringify(
      platformCommercialContracts.billingAccounts.operator.archive.body.parse(input),
    ),
  });
}
