export interface NationalCatalogClientDependencies {
  fetch: typeof fetch;
  scheduleAbort: (controller: AbortController, timeoutMs: number) => () => void;
}

export const productionNationalCatalogClientDependencies: NationalCatalogClientDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  scheduleAbort: (controller, timeoutMs) => {
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return () => clearTimeout(timeout);
  },
};

/** Explicitly configured National Catalog endpoint plus a server-side ChZ bearer. */
export interface NationalCatalogAuth {
  baseUrl: string;
  token: string;
}

export interface NationalCatalogRequestOptions {
  ifNoneMatch?: string;
}

export interface NationalCatalogCategoriesRequest extends NationalCatalogRequestOptions {
  catId?: number;
  gismtCode?: number;
  tnved?: string;
}

export type NationalCatalogAttributeType = "a" | "b" | "m" | "r" | "o";

/** Bounded documented selectors for `/v3/attributes`. */
export interface NationalCatalogAttributesRequest extends NationalCatalogRequestOptions {
  catId?: number;
  tnved?: string;
  isSet?: boolean;
  attrType?: NationalCatalogAttributeType;
}

export interface NationalCatalogCategory {
  id: number;
  name: string;
  parentId: number | null;
  level: number;
  active: boolean;
  gismtCodes: number[];
  raw: Record<string, unknown>;
}

export interface NationalCatalogAttributeDefinition {
  id: number;
  groupId: number;
  groupName: string;
  name: string;
  presetOnly: boolean;
  multiplicity: boolean;
  multiplicityType: "regular" | "unique" | null;
  fieldType: "number" | "text" | "date" | null;
  valueTypes: string[];
  dependentAttributes: NationalCatalogDependentAttribute[];
  firstLayer: boolean;
  secondLayer: boolean;
  type: string | null;
  preset: string[];
  presetUrl: string | null;
  raw: Record<string, unknown>;
}

export interface NationalCatalogDependentAttribute {
  value: string | null;
  attributes: NationalCatalogDependentAttributeRule[];
}

export interface NationalCatalogDependentAttributeRule {
  id: number | null;
  firstLayer: boolean;
  secondLayer: boolean;
  type: string | null;
}

export interface NationalCatalogProductIdentifier {
  value: string;
  type: string;
  multiplier: number | null;
  level: string | null;
}

export interface NationalCatalogProductCategory {
  id: number;
  name: string;
}

export interface NationalCatalogProductAttribute {
  id: number;
  name: string;
  value: string;
  valueId: number | null;
  attributeValueId: number | null;
  valueType: string | null;
  groupId: number | null;
  groupName: string | null;
  locationId: number | null;
  level: string | null;
  gtin: string | null;
  multiplier: number | null;
}

export interface NationalCatalogProduct {
  id: number;
  name: string | null;
  status: string | null;
  identifiers: NationalCatalogProductIdentifier[];
  categories: NationalCatalogProductCategory[];
  attributes: NationalCatalogProductAttribute[];
  raw: Record<string, unknown>;
}

export interface NationalCatalogCategoriesResponse {
  categories: NationalCatalogCategory[];
}

export interface NationalCatalogAttributesResponse {
  attributes: NationalCatalogAttributeDefinition[];
}

export interface NationalCatalogProductsResponse {
  products: NationalCatalogProduct[];
}

export interface NationalCatalogEtagsRequest extends NationalCatalogRequestOptions {
  brandId?: number;
  ownerInn?: string;
  catId?: number;
  offset?: number;
}

export interface NationalCatalogEtagEntry {
  goodId: number;
  etag: string;
}

export interface NationalCatalogEtagsResponse {
  goodsCount: number;
  offset: number;
  lastProductNumber: number;
  total: number;
  goods: NationalCatalogEtagEntry[];
}

export interface NationalCatalogUsageValue {
  used: number;
  limit: number;
}

export interface NationalCatalogUsage {
  total: NationalCatalogUsageValue | null;
  method: NationalCatalogUsageValue | null;
}

export interface NationalCatalogOk<T> {
  status: "ok";
  value: T;
  etag: string | null;
  contentHash: string;
  usage: NationalCatalogUsage;
}

export type NationalCatalogResult<T> =
  | NationalCatalogOk<T>
  | { status: "not_modified" }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "forbidden"; message: string }
  | { status: "rate_limited"; retryAfterSeconds: number | null }
  | { status: "invalid_response" }
  | { status: "unavailable" };
