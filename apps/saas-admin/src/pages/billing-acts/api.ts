import {
  platformCommercialContracts,
  type BillingAct,
  type BillingActCreateDto,
  type PrintDocumentVariant,
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

export function getBillingActDocumentDownload(actId: string, documentId: string) {
  const params = platformCommercialContracts.billingActs.documents.download.params.parse({
    actId,
    documentId,
  });
  return platformApiFetch(`/billing/acts/${params.actId}/documents/${params.documentId}/download`, {
    responseSchema: platformCommercialContracts.billingActs.documents.download.response,
  });
}

export function listBillingActs() {
  return platformApiFetch("/billing/acts", {
    responseSchema: platformCommercialContracts.billingActs.list.response,
  });
}

export function issueBillingAct(
  id: string,
  idempotencyKey: string,
  printVariant: PrintDocumentVariant = "clean",
): Promise<BillingAct> {
  const actId = platformCommercialContracts.billingActs.issue.params.parse(id);
  const body = platformCommercialContracts.billingActs.issue.body.parse({
    idempotencyKey,
    printVariant,
  });
  return platformApiFetch(`/billing/acts/${actId}/issue`, {
    responseSchema: platformCommercialContracts.billingActs.issue.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}
