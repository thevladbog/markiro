import {
  platformCommercialContracts,
  type BillingPayment,
  type PaymentImportInput,
  type PaymentImportResult,
  type PaymentMatch,
  type PaymentMatchResolveInput,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type { BillingPayment, PaymentImportResult, PaymentMatch, PaymentMatchResolveInput };

export function listPayments() {
  return platformApiFetch("/payments", {
    responseSchema: platformCommercialContracts.payments.list.response,
  });
}

export function listPaymentMatches() {
  return platformApiFetch("/payments/matches", {
    responseSchema: platformCommercialContracts.payments.matches.list.response,
  });
}

export function importPayments(input: PaymentImportInput) {
  const validated = platformCommercialContracts.payments.import.body.parse(input);
  return platformApiFetch("/payments/imports", {
    responseSchema: platformCommercialContracts.payments.import.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export function resolvePaymentMatch(id: string, input: PaymentMatchResolveInput) {
  const validatedId = platformCommercialContracts.payments.matches.resolve.params.parse(id);
  const validated = platformCommercialContracts.payments.matches.resolve.body.parse(input);
  return platformApiFetch(`/payments/matches/${validatedId}`, {
    responseSchema: platformCommercialContracts.payments.matches.resolve.response,
    method: "PATCH",
    body: JSON.stringify(validated),
  });
}
