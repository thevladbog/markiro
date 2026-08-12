import { platformApiFetch } from "../../api/client.js";

export interface PlanEntitlements {
  maxLines: number | null;
  maxStations: number | null;
  maxKiosks: number | null;
  maxCabinetUsers: number | null;
  labelEditorEnabled: boolean;
  publicApiEnabled: boolean;
  palletsEnabled: boolean;
  demoDurationDays: number | null;
}

export type AddonEffect =
  | {
      key: "lines" | "stations" | "kiosks" | "cabinetUsers";
      quotaIncrement: number;
    }
  | {
      key: "labelEditor" | "publicApi" | "pallets";
      featureEnabled: true;
    };

export interface CatalogVersionDto {
  id: string;
  catalogItemId: string;
  catalogItemCode: string;
  kind: "plan" | "addon" | "service";
  version: number;
  status: "draft" | "published" | "retired";
  nameRu: string;
  nameEn: string;
  descriptionRu: string | null;
  descriptionEn: string | null;
  unit: string;
  billingMode: "one_time" | "recurring";
  billingPeriod: "month" | "year" | null;
  unitPrice?: string;
  vatRateBps?: number | null;
  vatIncluded?: boolean;
  publishedAt: string | null;
  publishedByPlatformUserId: string | null;
  plan?: PlanEntitlements;
  addon?: { effects: AddonEffect[] };
  service?: Record<string, never>;
}

export type CatalogVersionPatch = Partial<
  Pick<
    CatalogVersionDto,
    | "nameRu"
    | "nameEn"
    | "descriptionRu"
    | "descriptionEn"
    | "unit"
    | "billingMode"
    | "billingPeriod"
    | "unitPrice"
    | "vatRateBps"
    | "vatIncluded"
  >
> & {
  plan?: PlanEntitlements;
  addon?: { effects: AddonEffect[] };
  service?: Record<string, never>;
};

export function listCatalogVersions(): Promise<{ items: CatalogVersionDto[] }> {
  return platformApiFetch("/catalog/items");
}

export type CatalogCreateInput = CatalogVersionPatch & {
  nameRu: string;
  nameEn: string;
  unit: string;
  billingMode: "one_time" | "recurring";
  billingPeriod: "month" | "year" | null;
  unitPrice: string;
  vatRateBps: number | null;
  vatIncluded: boolean;
  plan?: PlanEntitlements;
  addon?: { effects: AddonEffect[] };
  service?: Record<string, never>;
};

export function catalogVersionToCreateInput(item: CatalogVersionDto): CatalogCreateInput {
  if (!item.unitPrice) throw new Error("catalog_version_financial_terms_missing");
  const common = {
    nameRu: item.nameRu,
    nameEn: item.nameEn,
    descriptionRu: item.descriptionRu,
    descriptionEn: item.descriptionEn,
    unit: item.unit,
    billingMode: item.billingMode,
    billingPeriod: item.billingPeriod,
    unitPrice: item.unitPrice,
    vatRateBps: item.vatRateBps ?? null,
    vatIncluded: item.vatRateBps !== null && item.vatIncluded === true,
  } as const;
  if (item.kind === "plan") {
    if (!item.plan) throw new Error("catalog_version_plan_missing");
    return { ...common, plan: { ...item.plan } };
  }
  if (item.kind === "addon") {
    if (!item.addon) throw new Error("catalog_version_addon_missing");
    return { ...common, addon: { effects: item.addon.effects.map((effect) => ({ ...effect })) } };
  }
  if (!item.service) throw new Error("catalog_version_service_missing");
  return { ...common, service: {} };
}

export function createCatalogVersion(
  itemCode: string,
  input: CatalogCreateInput,
): Promise<CatalogVersionDto> {
  return platformApiFetch(`/catalog/items/${itemCode}/versions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getDefaultDemoPlan(): Promise<{ catalogVersionId: string | null }> {
  return platformApiFetch("/settings/demo-plan");
}

export function updateCatalogVersion(
  itemCode: string,
  versionId: string,
  patch: CatalogVersionPatch,
): Promise<CatalogVersionDto> {
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function publishCatalogVersion(
  itemCode: string,
  versionId: string,
): Promise<CatalogVersionDto> {
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}/publish`, {
    method: "POST",
    body: "{}",
  });
}

export function retireCatalogVersion(
  itemCode: string,
  versionId: string,
): Promise<CatalogVersionDto> {
  return platformApiFetch(`/catalog/items/${itemCode}/versions/${versionId}/retire`, {
    method: "POST",
    body: "{}",
  });
}

export function archiveCatalogItem(itemCode: string): Promise<{ status: "archived" }> {
  return platformApiFetch(`/catalog/items/${itemCode}/archive`, {
    method: "POST",
    body: "{}",
  });
}

export function setDefaultDemoPlan(catalogVersionId: string) {
  return platformApiFetch<{ catalogVersionId: string }>("/settings/demo-plan", {
    method: "PATCH",
    body: JSON.stringify({ catalogVersionId }),
  });
}
