import {
  platformAgreementContracts,
  type AgreementDetail,
  type AgreementListQuery,
  type AgreementStatus,
  type AgreementSummary,
  type CreateAgreementInput,
  type UpdateAgreementInput,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type { AgreementDetail, AgreementStatus, AgreementSummary };
export type AgreementDocument = AgreementDetail["documents"][number];

export function listAgreements(query: AgreementListQuery = {}) {
  const validated = platformAgreementContracts.list.query.parse(query);
  const search = new URLSearchParams(
    Object.entries(validated).map(([key, value]) => [key, String(value)]),
  ).toString();
  return platformApiFetch(`/agreements${search ? `?${search}` : ""}`, {
    responseSchema: platformAgreementContracts.list.response,
  });
}

export function getAgreement(id: string) {
  const validatedId = platformAgreementContracts.detail.params.parse(id);
  return platformApiFetch(`/agreements/${validatedId}`, {
    responseSchema: platformAgreementContracts.detail.response,
  });
}

export function createAgreement(input: CreateAgreementInput) {
  const body = platformAgreementContracts.create.body.parse(input);
  return platformApiFetch("/agreements", {
    responseSchema: platformAgreementContracts.create.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateAgreement(id: string, input: UpdateAgreementInput) {
  const validatedId = platformAgreementContracts.update.params.parse(id);
  const body = platformAgreementContracts.update.body.parse(input);
  return platformApiFetch(`/agreements/${validatedId}`, {
    responseSchema: platformAgreementContracts.update.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function transitionAgreement(
  id: string,
  status: AgreementStatus,
  terminationReason?: string,
) {
  const validatedId = platformAgreementContracts.transition.params.parse(id);
  const body = platformAgreementContracts.transition.body.parse(
    terminationReason === undefined ? { status } : { status, terminationReason },
  );
  return platformApiFetch(`/agreements/${validatedId}/transition`, {
    responseSchema: platformAgreementContracts.transition.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function linkAgreementTenant(id: string, tenantId: string) {
  const validatedId = platformAgreementContracts.linkTenant.params.parse(id);
  const body = platformAgreementContracts.linkTenant.body.parse({ tenantId });
  return platformApiFetch(`/agreements/${validatedId}/tenant`, {
    responseSchema: platformAgreementContracts.linkTenant.response,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function unlinkAgreementTenant(id: string) {
  const validatedId = platformAgreementContracts.unlinkTenant.params.parse(id);
  return platformApiFetch(`/agreements/${validatedId}/tenant`, {
    responseSchema: platformAgreementContracts.unlinkTenant.response,
    method: "DELETE",
  });
}

export function agreementTenantCandidates(id: string) {
  const validatedId = platformAgreementContracts.tenantCandidates.params.parse(id);
  return platformApiFetch(`/agreements/${validatedId}/tenant-candidates`, {
    responseSchema: platformAgreementContracts.tenantCandidates.response,
  });
}

export function renderAgreementDraft(id: string) {
  const validatedId = platformAgreementContracts.documents.render.params.parse(id);
  return platformApiFetch(`/agreements/${validatedId}/documents/draft`, {
    responseSchema: platformAgreementContracts.documents.render.response,
    method: "POST",
    body: "{}",
  });
}

export function downloadAgreementDocument(id: string, documentId: string) {
  const params = platformAgreementContracts.documents.download.params.parse({ id, documentId });
  return platformApiFetch(`/agreements/${params.id}/documents/${params.documentId}/download`, {
    responseSchema: platformAgreementContracts.documents.download.response,
    method: "POST",
    body: "{}",
  });
}

export function uploadAgreementAttachment(id: string, file: File) {
  const validatedId = platformAgreementContracts.attachments.upload.params.parse(id);
  const form = new FormData();
  form.append("file", file);
  // No Content-Type header: the browser must set the multipart boundary.
  return platformApiFetch(`/agreements/${validatedId}/attachments`, {
    responseSchema: platformAgreementContracts.attachments.upload.response,
    method: "POST",
    body: form,
  });
}

export function deleteAgreementAttachment(id: string, documentId: string) {
  const params = platformAgreementContracts.attachments.delete.params.parse({ id, documentId });
  return platformApiFetch(`/agreements/${params.id}/attachments/${params.documentId}`, {
    responseSchema: platformAgreementContracts.attachments.delete.response,
    method: "DELETE",
  });
}
