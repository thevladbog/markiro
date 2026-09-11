import {
  platformCatalogV2Contracts,
  type AddonEffect,
  type CatalogVersionV2 as CatalogVersion,
  type CatalogVersionCreateV2 as CatalogVersionCreate,
  type CatalogVersionPatchV2 as SharedCatalogVersionPatch,
  type CommercialReviewIdentity,
  COMMERCIAL_VERSION_HEADER,
  COMMERCIAL_VERSION,
  type PlanEntitlements,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type CatalogVersionDto = CatalogVersion;
export type CatalogVersionPatch = SharedCatalogVersionPatch;
export type CatalogCreateInput = CatalogVersionCreate;
export type { AddonEffect, PlanEntitlements };

export function listCatalogVersions() {
  return platformApiFetch("/catalog/items", {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.list.response,
  });
}

export function catalogVersionToCreateInput(item: CatalogVersion): CatalogVersionCreate {
  if (
    item.unitPrice === undefined ||
    item.vatRateBps === undefined ||
    item.vatIncluded === undefined
  ) {
    throw new Error("catalog_version_financial_terms_missing");
  }
  const common = {
    documentNameRu: item.documentNameRu,
    documentNameEn: item.documentNameEn,
    subject: item.subject,
    sellerPolicyRevision: item.sellerPolicyRevision,
    nameRu: item.nameRu,
    nameEn: item.nameEn,
    descriptionRu: item.descriptionRu,
    descriptionEn: item.descriptionEn,
    unit: item.unit,
    billingMode: item.billingMode,
    billingPeriod: item.billingPeriod,
    unitPrice: item.unitPrice,
    vatRateBps: item.vatRateBps,
    vatIncluded: item.vatIncluded,
  } as const;
  if (item.kind === "plan") {
    return platformCatalogV2Contracts.createVersion.body.parse({
      ...common,
      plan: { ...item.plan },
    });
  }
  if (item.kind === "addon") {
    return platformCatalogV2Contracts.createVersion.body.parse({
      ...common,
      addon: { effects: item.addon.effects.map((effect) => ({ ...effect })) },
    });
  }
  return platformCatalogV2Contracts.createVersion.body.parse({ ...common, service: {} });
}

export function createCatalogVersion(itemCode: string, input: CatalogVersionCreate) {
  const validated = platformCatalogV2Contracts.createVersion.body.parse(input);
  return platformApiFetch(`/catalog/items/${itemCode}/versions`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.createVersion.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export function getDefaultDemoPlan() {
  return platformApiFetch("/settings/demo-plan", {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.getDefaultDemo.response,
  });
}

export function updateCatalogVersion(
  itemCode: string,
  versionId: string,
  patch: CatalogVersionPatch,
) {
  const validated = platformCatalogV2Contracts.updateVersion.body.parse(patch);
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.updateVersion.response,
    method: "PATCH",
    body: JSON.stringify(validated),
  });
}

export function publishCatalogVersion(
  itemCode: string,
  versionId: string,
  identity: CommercialReviewIdentity,
) {
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}/publish`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.publishVersion.response,
    method: "POST",
    body: JSON.stringify(identity),
  });
}

export function retireCatalogVersion(itemCode: string, versionId: string) {
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}/retire`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.retireVersion.response,
    method: "POST",
    body: "{}",
  });
}

export function archiveCatalogItem(itemCode: string) {
  return platformApiFetch(`/catalog/items/${itemCode}/archive`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.archiveItem.response,
    method: "POST",
    body: "{}",
  });
}

export function setDefaultDemoPlan(catalogVersionId: string) {
  const validated = platformCatalogV2Contracts.setDefaultDemo.body.parse({ catalogVersionId });
  return platformApiFetch("/settings/demo-plan", {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.setDefaultDemo.response,
    method: "PATCH",
    body: JSON.stringify(validated),
  });
}

export function getCatalogEditorContext() {
  return platformApiFetch("/catalog/editor-context", {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.editorContext.response,
  });
}
export function reviewCatalogVersion(itemCode: string, versionId: string) {
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}/review`, {
    method: "POST",
    body: "{}",
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.reviewVersion.response,
  });
}

export function getCatalogVersion(itemCode: string, versionId: string) {
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: COMMERCIAL_VERSION },
    responseSchema: platformCatalogV2Contracts.getVersion.response,
  });
}
