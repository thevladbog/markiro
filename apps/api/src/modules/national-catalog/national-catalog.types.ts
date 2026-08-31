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

export interface NationalCatalogCategory {
  id: number;
  name: string;
  parentId: number | null;
  level: number;
  active: boolean;
  gismtCodes: number[];
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
  dependentAttributes: unknown[];
  firstLayer: boolean;
  secondLayer: boolean;
  type: string | null;
  preset: unknown[];
  presetUrl: string | null;
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
}

/**
 * The raw envelope is intentionally server-only. It preserves provider fields
 * not yet modeled by Markiro without promoting them into the normalized API.
 */
export interface NationalCatalogCategoriesResponse {
  categories: NationalCatalogCategory[];
  raw: Record<string, unknown>;
}

export interface NationalCatalogAttributesResponse {
  attributes: NationalCatalogAttributeDefinition[];
  raw: Record<string, unknown>;
}

export interface NationalCatalogProductsResponse {
  products: NationalCatalogProduct[];
  raw: Record<string, unknown>;
}

export type NationalCatalogResult<T> =
  | { status: "ok"; value: T; etag: string | null }
  | { status: "not_modified" }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "forbidden"; message: string }
  | { status: "rate_limited"; retryAfterSeconds: number | null }
  | { status: "invalid_response" }
  | { status: "unavailable" };
