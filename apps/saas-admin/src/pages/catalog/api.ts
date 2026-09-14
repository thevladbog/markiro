import {
  platformCatalogV2Contracts,
  type CatalogVersionCreateV2,
  catalogVersionV4Schema,
  platformCatalogV4Contracts,
  type AddonEffectV3 as AddonEffect,
  type CatalogVersionV4 as CatalogVersion,
  type CatalogVersionCreateV4 as CatalogVersionCreate,
  type CatalogVersionPatchV4 as SharedCatalogVersionPatch,
  type CommercialReviewIdentityV3 as CommercialReviewIdentity,
  COMMERCIAL_VERSION_HEADER,
  type PlanEntitlementsV3 as PlanEntitlements,
  platformOfflineGrantPolicyContracts,
  type ApproveOfflineGrantPolicy,
  type CreateOfflineGrantPolicy,
} from "@markiro/platform-contracts";

import { platformApiFetch, CURRENT_COMMERCIAL_VERSION } from "../../api/client.js";

export type CatalogVersionDto = CatalogVersion;
export type CatalogVersionPatch = SharedCatalogVersionPatch;
export type CatalogCreateInput = CatalogVersionCreate;
export type { AddonEffect, PlanEntitlements };
export type OfflineGrantPolicyDto = Awaited<
  ReturnType<typeof listOfflineGrantPolicies>
>["items"][number];

export function listOfflineGrantPolicies() {
  return platformApiFetch("/catalog/lifecycle-policies", {
    responseSchema: platformOfflineGrantPolicyContracts.list.response,
  });
}

export function createOfflineGrantPolicy(input: CreateOfflineGrantPolicy) {
  const body = platformOfflineGrantPolicyContracts.create.body.parse(input);
  return platformApiFetch("/catalog/lifecycle-policies", {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformOfflineGrantPolicyContracts.create.response,
  });
}

export function approveOfflineGrantPolicy(id: string, input: ApproveOfflineGrantPolicy) {
  const body = platformOfflineGrantPolicyContracts.approve.body.parse(input);
  return platformApiFetch(`/catalog/lifecycle-policies/${id}/approve`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformOfflineGrantPolicyContracts.approve.response,
  });
}

export function listCatalogVersions() {
  return platformApiFetch("/catalog/items", {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.list.response,
  });
}

export function catalogVersionToCreateInput(
  item: CatalogVersion,
): CatalogVersionCreate | CatalogVersionCreateV2 {
  if (
    item.unitPrice === undefined ||
    item.vatRateBps === undefined ||
    item.vatIncluded === undefined
  ) {
    throw new Error("catalog_version_financial_terms_missing");
  }
  const common = {
    lifecyclePolicyId: item.lifecyclePolicyId,
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
    const {
      chzIntegrationEnabled,
      inventoryEnabled,
      commerceMlEnabled,
      handheldEnabled,
      ...legacyPlan
    } = item.plan;
    if (
      item.lifecyclePolicyId === null &&
      [chzIntegrationEnabled, inventoryEnabled, commerceMlEnabled, handheldEnabled].every(
        (value) => value === null,
      )
    ) {
      const { lifecyclePolicyId, ...legacyCommon } = common;
      void lifecyclePolicyId;
      return platformCatalogV2Contracts.createVersion.body.parse({
        ...legacyCommon,
        plan: legacyPlan,
      });
    }
    return platformCatalogV4Contracts.createVersion.body.parse({
      ...common,
      plan: { ...item.plan },
    });
  }
  if (item.kind === "addon") {
    return platformCatalogV4Contracts.createVersion.body.parse({
      ...common,
      addon: { effects: item.addon.effects.map((effect) => ({ ...effect })) },
    });
  }
  return platformCatalogV4Contracts.createVersion.body.parse({
    ...common,
    service: { ...item.service },
  });
}

export async function createCatalogVersion(
  itemCode: string,
  input: CatalogVersionCreate | CatalogVersionCreateV2,
) {
  // Only the fully unmapped legacy clone builder omits lifecyclePolicyId.
  if (!("lifecyclePolicyId" in input)) {
    const legacy = platformCatalogV2Contracts.createVersion.body.parse(input);
    if (!("plan" in legacy)) throw new Error("legacy_clone_requires_plan");
    const result = await platformApiFetch(`/catalog/items/${itemCode}/versions`, {
      headers: { [COMMERCIAL_VERSION_HEADER]: "2" },
      method: "POST",
      body: JSON.stringify(legacy),
      responseSchema: platformCatalogV2Contracts.createVersion.response,
    });
    return catalogVersionV4Schema.parse({
      ...result,
      lifecyclePolicyId: null,
      ...(result.kind === "plan"
        ? {
            plan: {
              ...result.plan,
              chzIntegrationEnabled: null,
              inventoryEnabled: null,
              commerceMlEnabled: null,
              handheldEnabled: null,
            },
          }
        : {}),
    });
  }
  const validated = platformCatalogV4Contracts.createVersion.body.parse(input);
  return platformApiFetch(`/catalog/items/${itemCode}/versions`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.createVersion.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export function getDefaultDemoPlan() {
  return platformApiFetch("/settings/demo-plan", {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.getDefaultDemo.response,
  });
}

export function updateCatalogVersion(
  itemCode: string,
  versionId: string,
  patch: CatalogVersionPatch,
) {
  const validated = platformCatalogV4Contracts.updateVersion.body.parse(patch);
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.updateVersion.response,
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
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.publishVersion.response,
    method: "POST",
    body: JSON.stringify(identity),
  });
}

export function retireCatalogVersion(itemCode: string, versionId: string) {
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}/retire`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.retireVersion.response,
    method: "POST",
    body: "{}",
  });
}

export function archiveCatalogItem(itemCode: string) {
  return platformApiFetch(`/catalog/items/${itemCode}/archive`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.archiveItem.response,
    method: "POST",
    body: "{}",
  });
}

export function setDefaultDemoPlan(catalogVersionId: string) {
  const validated = platformCatalogV4Contracts.setDefaultDemo.body.parse({ catalogVersionId });
  return platformApiFetch("/settings/demo-plan", {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.setDefaultDemo.response,
    method: "PATCH",
    body: JSON.stringify(validated),
  });
}

export function getCatalogEditorContext() {
  return platformApiFetch("/catalog/editor-context", {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.editorContext.response,
  });
}
export function reviewCatalogVersion(itemCode: string, versionId: string) {
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}/review`, {
    method: "POST",
    body: "{}",
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.reviewVersion.response,
  });
}

export function getCatalogVersion(itemCode: string, versionId: string) {
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV4Contracts.getVersion.response,
  });
}
