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

export interface NationalCatalogResponseMetadata {
  /** Fixed provider route only; no query, URL, token or card data. */
  method: string;
  status: number;
  usage: {
    total: { used: number; limit: number } | null;
    method: { used: number; limit: number } | null;
  };
  retryAfterSeconds: number | null;
}

export interface NationalCatalogRequestOptions {
  ifNoneMatch?: string;
  signal?: AbortSignal;
  onResponse?: (metadata: NationalCatalogResponseMetadata) => void;
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

export interface NationalCatalogProductImage {
  sourceId: string;
  url: string;
  barcode: string | null;
  primary: boolean;
}

export type NationalCatalogProductImageIssueReason =
  "invalid_collection" | "invalid_record" | "invalid_url" | "invalid_barcode" | "unsupported_media";

export interface NationalCatalogProductImageIssue {
  sourceId: string;
  reason: NationalCatalogProductImageIssueReason;
}

export interface NationalCatalogProduct {
  id: number;
  name: string | null;
  status: string | null;
  detailedStatuses: string[];
  identifiers: NationalCatalogProductIdentifier[];
  categories: NationalCatalogProductCategory[];
  attributes: NationalCatalogProductAttribute[];
  images: NationalCatalogProductImage[];
  imageIssues: NationalCatalogProductImageIssue[];
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

export type NationalCatalogListRequest = {
  updatedFrom: string;
  updatedTo: string;
  offset: number;
  limit: number;
};

export type NationalCatalogListRow = {
  cardId: string;
  gtins: string[];
  name: string | null;
  brand: string | null;
  status: string | null;
  detailedStatuses: string[];
  raw: Record<string, unknown>;
};

export type NationalCatalogListPage = {
  rows: NationalCatalogListRow[];
  nextOffset: number | null;
};

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

export type NationalCatalogListResult =
  NationalCatalogResult<NationalCatalogListPage> | { status: "selection_too_large" };
