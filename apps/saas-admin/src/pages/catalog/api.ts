import {
  platformCatalogContracts,
  type AddonEffect,
  type CatalogVersion,
  type CatalogVersionCreate,
  type CatalogVersionPatch as SharedCatalogVersionPatch,
  type PlanEntitlements,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type CatalogVersionDto = CatalogVersion;
export type CatalogVersionPatch = SharedCatalogVersionPatch;
export type CatalogCreateInput = CatalogVersionCreate;
export type { AddonEffect, PlanEntitlements };

export function listCatalogVersions() {
  return platformApiFetch("/catalog/items", platformCatalogContracts.list.response);
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
    return platformCatalogContracts.createVersion.body.parse({
      ...common,
      plan: { ...item.plan },
    });
  }
  if (item.kind === "addon") {
    return platformCatalogContracts.createVersion.body.parse({
      ...common,
      addon: { effects: item.addon.effects.map((effect) => ({ ...effect })) },
    });
  }
  return platformCatalogContracts.createVersion.body.parse({ ...common, service: {} });
}

export function createCatalogVersion(itemCode: string, input: CatalogVersionCreate) {
  const validated = platformCatalogContracts.createVersion.body.parse(input);
  return platformApiFetch(
    `/catalog/items/${itemCode}/versions`,
    platformCatalogContracts.createVersion.response,
    {
      method: "POST",
      body: JSON.stringify(validated),
    },
  );
}

export function getDefaultDemoPlan() {
  return platformApiFetch("/settings/demo-plan", platformCatalogContracts.getDefaultDemo.response);
}

export function updateCatalogVersion(
  itemCode: string,
  versionId: string,
  patch: CatalogVersionPatch,
) {
  const validated = platformCatalogContracts.updateVersion.body.parse(patch);
  return platformApiFetch(
    `/catalog/items/${itemCode}/versions/${versionId}`,
    platformCatalogContracts.updateVersion.response,
    {
      method: "PATCH",
      body: JSON.stringify(validated),
    },
  );
}

export function publishCatalogVersion(itemCode: string, versionId: string) {
  return platformApiFetch(
    `/catalog/items/${itemCode}/versions/${versionId}/publish`,
    platformCatalogContracts.publishVersion.response,
    { method: "POST", body: "{}" },
  );
}

export function retireCatalogVersion(itemCode: string, versionId: string) {
  return platformApiFetch(
    `/catalog/items/${itemCode}/versions/${versionId}/retire`,
    platformCatalogContracts.retireVersion.response,
    { method: "POST", body: "{}" },
  );
}

export function archiveCatalogItem(itemCode: string) {
  return platformApiFetch(
    `/catalog/items/${itemCode}/archive`,
    platformCatalogContracts.archiveItem.response,
    { method: "POST", body: "{}" },
  );
}

export function setDefaultDemoPlan(catalogVersionId: string) {
  const validated = platformCatalogContracts.setDefaultDemo.body.parse({ catalogVersionId });
  return platformApiFetch("/settings/demo-plan", platformCatalogContracts.setDefaultDemo.response, {
    method: "PATCH",
    body: JSON.stringify(validated),
  });
}
