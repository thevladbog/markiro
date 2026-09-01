import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

import {
  productionNationalCatalogClientDependencies,
  type NationalCatalogAttributeDefinition,
  type NationalCatalogAttributesRequest,
  type NationalCatalogAttributesResponse,
  type NationalCatalogAuth,
  type NationalCatalogCategoriesRequest,
  type NationalCatalogCategoriesResponse,
  type NationalCatalogCategory,
  type NationalCatalogClientDependencies,
  type NationalCatalogDependentAttribute,
  type NationalCatalogDependentAttributeRule,
  type NationalCatalogEtagsRequest,
  type NationalCatalogEtagsResponse,
  type NationalCatalogProduct,
  type NationalCatalogProductAttribute,
  type NationalCatalogProductCategory,
  type NationalCatalogProductIdentifier,
  type NationalCatalogProductsResponse,
  type NationalCatalogRequestOptions,
  type NationalCatalogResult,
} from "./national-catalog.types";

export type { NationalCatalogClientDependencies } from "./national-catalog.types";

const CATEGORIES_PATH = "/v3/categories";
const ATTRIBUTES_PATH = "/v3/attributes";
const ETAGS_PATH = "/v3/etagslist";
const FEED_PRODUCT_PATH = "/v3/feed-product";
const PRODUCT_PATH = "/v3/product";
export const NATIONAL_CATALOG_PRODUCT_BATCH_LIMIT = 25;
export const NATIONAL_CATALOG_RESPONSE_BYTE_LIMITS = {
  categories: 4 * 1024 * 1024,
  attributes: 16 * 1024 * 1024,
  products: 16 * 1024 * 1024,
  etags: 1024 * 1024,
} as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const REJECTION_RESPONSE_BYTE_LIMIT = 64 * 1024;
const ETAGS_PAGE_LIMIT = 100;
const ATTRIBUTE_TYPES = ["a", "b", "m", "r", "o"] as const;

@Injectable()
export class NationalCatalogClient {
  constructor(
    private readonly dependencies: NationalCatalogClientDependencies = productionNationalCatalogClientDependencies,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  async listCategories(
    auth: NationalCatalogAuth,
    options: NationalCatalogCategoriesRequest = {},
  ): Promise<NationalCatalogResult<NationalCatalogCategoriesResponse>> {
    return this.request(
      auth,
      categoriesPath(options),
      options,
      NATIONAL_CATALOG_RESPONSE_BYTE_LIMITS.categories,
      parseCategories,
    );
  }

  async getAttributes(
    auth: NationalCatalogAuth,
    options: NationalCatalogAttributesRequest = {},
  ): Promise<NationalCatalogResult<NationalCatalogAttributesResponse>> {
    return this.request(
      auth,
      attributesPath(options),
      options,
      NATIONAL_CATALOG_RESPONSE_BYTE_LIMITS.attributes,
      parseAttributes,
    );
  }

  async listEtags(
    auth: NationalCatalogAuth,
    options: NationalCatalogEtagsRequest = {},
  ): Promise<NationalCatalogResult<NationalCatalogEtagsResponse>> {
    return this.request(
      auth,
      etagsPath(options),
      options,
      NATIONAL_CATALOG_RESPONSE_BYTE_LIMITS.etags,
      parseEtags,
    );
  }

  async getFeedProducts(
    auth: NationalCatalogAuth,
    gtins: string[],
    options: NationalCatalogRequestOptions = {},
  ): Promise<NationalCatalogResult<NationalCatalogProductsResponse>> {
    return this.request(
      auth,
      productPath(FEED_PRODUCT_PATH, gtins),
      options,
      NATIONAL_CATALOG_RESPONSE_BYTE_LIMITS.products,
      parseProducts,
    );
  }

  async getPublishedProducts(
    auth: NationalCatalogAuth,
    gtins: string[],
    options: NationalCatalogRequestOptions = {},
  ): Promise<NationalCatalogResult<NationalCatalogProductsResponse>> {
    return this.request(
      auth,
      productPath(PRODUCT_PATH, gtins),
      options,
      NATIONAL_CATALOG_RESPONSE_BYTE_LIMITS.products,
      parseProducts,
    );
  }

  private async request<T>(
    auth: NationalCatalogAuth,
    path: string,
    options: NationalCatalogRequestOptions,
    responseByteLimit: number,
    parse: (payload: unknown) => T | null,
  ): Promise<NationalCatalogResult<T>> {
    const controller = new AbortController();
    const cancelAbort = this.dependencies.scheduleAbort(controller, this.requestTimeoutMs);
    try {
      const headers = new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${auth.token}`,
      });
      if (options.ifNoneMatch) headers.set("If-None-Match", options.ifNoneMatch);

      const response = await this.dependencies.fetch(urlFor(auth.baseUrl, path), {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (response.status === 304) return { status: "not_modified" };
      if (response.status === 401) return { status: "unauthorized" };
      if (response.status === 403) {
        return {
          status: "forbidden",
          message: await rejectionMessage(response, controller),
        };
      }
      if (response.status === 404) return { status: "not_found" };
      if (response.status === 429) {
        return { status: "rate_limited", retryAfterSeconds: retryAfterSeconds(response) };
      }
      // The result union deliberately has no generic rejected branch. A 4xx
      // other than the documented, actionable statuses above means our fixed
      // request contract and the provider disagreed, so it cannot be trusted
      // as data or retried as a transport failure.
      if (response.status >= 400 && response.status < 500) return { status: "invalid_response" };
      if (!response.ok) return { status: "unavailable" };

      const bytes = await readResponseBytes(response, responseByteLimit, controller);
      if (bytes === null) return { status: "invalid_response" };
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return { status: "invalid_response" };
      }
      const value = parse(payload);
      if (value === null) return { status: "invalid_response" };
      return {
        status: "ok",
        value,
        etag: response.headers.get("etag"),
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        usage: {
          total: usageValue(response.headers.get("API-Usage-Limit")),
          method: usageValue(response.headers.get("API-Method-Usage-Limit")),
        },
      };
    } catch {
      return { status: "unavailable" };
    } finally {
      cancelAbort();
    }
  }
}

function categoriesPath(options: NationalCatalogCategoriesRequest): string {
  const { catId, gismtCode, tnved } = options;
  validatePositiveInteger(catId, "catId");
  validatePositiveInteger(gismtCode, "gismtCode");
  validateTnved(tnved);
  const query = new URLSearchParams();
  if (catId !== undefined) query.set("cat_id", String(catId));
  if (gismtCode !== undefined) query.set("gismt_code", String(gismtCode));
  if (tnved !== undefined) query.set("tnved", tnved);
  return withQuery(CATEGORIES_PATH, query);
}

function attributesPath(options: NationalCatalogAttributesRequest): string {
  const { catId, tnved, isSet, attrType } = options;
  if (catId !== undefined && tnved !== undefined) {
    throw new TypeError("National Catalog attribute selectors cannot combine catId and tnved");
  }
  validatePositiveInteger(catId, "catId");
  validateTnved(tnved);
  if (isSet !== undefined && typeof isSet !== "boolean") {
    throw new TypeError("National Catalog isSet must be a boolean");
  }
  if (attrType !== undefined && !ATTRIBUTE_TYPES.includes(attrType)) {
    throw new TypeError("National Catalog attrType is invalid");
  }
  if (attrType !== undefined && catId === undefined && tnved === undefined && isSet === undefined) {
    throw new TypeError("National Catalog attrType requires catId, tnved, or isSet");
  }

  const query = new URLSearchParams();
  if (catId !== undefined) query.set("cat_id", String(catId));
  if (tnved !== undefined) query.set("tnved", tnved);
  if (isSet !== undefined) query.set("is_set", isSet ? "1" : "0");
  if (attrType !== undefined) query.set("attr_type", attrType);
  return withQuery(ATTRIBUTES_PATH, query);
}

function etagsPath(options: NationalCatalogEtagsRequest): string {
  const { brandId, ownerInn, catId, offset } = options;
  validatePositiveInteger(brandId, "brandId");
  validatePositiveInteger(catId, "catId");
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
    throw new TypeError("National Catalog offset must be a non-negative integer");
  }
  if (ownerInn !== undefined && !isValidInn(ownerInn)) {
    throw new TypeError("National Catalog ownerInn must be a valid INN");
  }
  const query = new URLSearchParams();
  if (brandId !== undefined) query.set("brand_id", String(brandId));
  if (ownerInn !== undefined) query.set("owner_inn", ownerInn);
  if (catId !== undefined) query.set("cat_id", String(catId));
  if (offset !== undefined) query.set("offset", String(offset));
  return withQuery(ETAGS_PATH, query);
}

function productPath(
  path: typeof FEED_PRODUCT_PATH | typeof PRODUCT_PATH,
  gtins: string[],
): string {
  if (gtins.length < 1 || gtins.length > NATIONAL_CATALOG_PRODUCT_BATCH_LIMIT) {
    throw new RangeError(
      `National Catalog product reads require one to ${NATIONAL_CATALOG_PRODUCT_BATCH_LIMIT} GTINs`,
    );
  }
  if (gtins.some((gtin) => !/^\d+$/.test(gtin))) {
    throw new TypeError("National Catalog GTINs must contain digits only");
  }
  return `${path}?${new URLSearchParams({ gtins: gtins.join(";") }).toString()}`;
}

function urlFor(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new TypeError("National Catalog base URL must be an HTTPS URL without userinfo");
  }
  return new URL(path, `${base.toString().replace(/\/$/, "")}/`).toString();
}

async function rejectionMessage(response: Response, controller: AbortController): Promise<string> {
  try {
    const bytes = await readResponseBytes(response, REJECTION_RESPONSE_BYTE_LIMIT, controller);
    if (bytes === null) return "";
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const record = asRecord(payload);
    const message = record?.error_message ?? record?.errorMessage ?? record?.message;
    return typeof message === "string" ? sanitizeRejectionMessage(message) : "";
  } catch {
    return "";
  }
}

function sanitizeRejectionMessage(message: string): string {
  return [...message]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .slice(0, 500);
}

async function readResponseBytes(
  response: Response,
  limit: number,
  controller: AbortController,
): Promise<Uint8Array | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function usageValue(value: string | null): { used: number; limit: number } | null {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const used = Number(match[1]);
  const limit = Number(match[2]);
  return Number.isSafeInteger(used) && Number.isSafeInteger(limit) && limit > 0 && used <= limit
    ? { used, limit }
    : null;
}

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError(`National Catalog ${name} must be a positive integer`);
  }
}

function validateTnved(value: string | undefined): void {
  if (value !== undefined && !/^\d{4,10}$/.test(value)) {
    throw new TypeError("National Catalog tnved must contain four to 10 digits");
  }
}

function withQuery(path: string, query: URLSearchParams): string {
  const serialized = query.toString();
  return serialized.length > 0 ? `${path}?${serialized}` : path;
}

function isValidInn(value: string): boolean {
  if (!/^\d{10}(?:\d{2})?$/.test(value)) return false;
  const digits = [...value].map(Number);
  const checksum = (weights: number[]): number =>
    (weights.reduce((sum, weight, index) => sum + weight * (digits[index] ?? 0), 0) % 11) % 10;
  if (digits.length === 10) {
    return checksum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[9];
  }
  return (
    checksum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[10] &&
    checksum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[11]
  );
}

function parseCategories(payload: unknown): NationalCatalogCategoriesResponse | null {
  const envelope = responseEnvelope(payload);
  if (!envelope) return null;
  const categories: NationalCatalogCategory[] = [];
  for (const row of envelope.result) {
    const record = asRecord(row);
    if (!record) return null;
    const id = number(record.cat_id);
    const name = string(record.cat_name);
    const parentId = nullableNumber(record.cat_parent_id);
    const level = number(record.cat_level);
    const active = boolean(record.category_active);
    const gismtCodes = optionalNumberArray(record.gismt_codes);
    if (
      id === null ||
      name === null ||
      parentId === undefined ||
      level === null ||
      active === null ||
      gismtCodes === null
    ) {
      return null;
    }
    categories.push({ id, name, parentId, level, active, gismtCodes, raw: record });
  }
  return { categories };
}

function parseAttributes(payload: unknown): NationalCatalogAttributesResponse | null {
  const envelope = responseEnvelope(payload);
  if (!envelope) return null;
  const attributes: NationalCatalogAttributeDefinition[] = [];
  for (const row of envelope.result) {
    const record = asRecord(row);
    if (!record) return null;
    const id = number(record.attr_id);
    const groupId = number(record.attr_group_id);
    const groupName = string(record.attr_group_name);
    const name = string(record.attr_name);
    const presetOnly = boolean(record.attr_preset_only);
    const multiplicity = boolean(record.attr_multiplicity);
    const multiplicityType = enumOrNull(record.attr_multiplicity_type, ["regular", "unique"]);
    const fieldType = optionalEnumOrNull(record.attr_field_type, ["number", "text", "date"]);
    const valueTypes = optionalStringArray(record.attr_value_type);
    const dependentAttributes = parseOptionalDependentAttributes(record.dependent_attributes);
    const firstLayer = boolean(record.first_layer);
    const secondLayer = boolean(record.second_layer);
    const type = optionalNullableString(record.attr_type);
    const preset = optionalStringArray(record.attr_preset);
    const presetUrl = optionalNullableString(record.preset_url);
    if (
      id === null ||
      groupId === null ||
      groupName === null ||
      name === null ||
      presetOnly === null ||
      multiplicity === null ||
      multiplicityType === undefined ||
      fieldType === undefined ||
      valueTypes === null ||
      dependentAttributes === null ||
      firstLayer === null ||
      secondLayer === null ||
      type === undefined ||
      preset === null ||
      presetUrl === undefined
    ) {
      return null;
    }
    attributes.push({
      id,
      groupId,
      groupName,
      name,
      presetOnly,
      multiplicity,
      multiplicityType,
      fieldType,
      valueTypes,
      dependentAttributes,
      firstLayer,
      secondLayer,
      type,
      preset,
      presetUrl,
      raw: record,
    });
  }
  return { attributes };
}

function parseProducts(payload: unknown): NationalCatalogProductsResponse | null {
  const envelope = responseEnvelope(payload);
  if (!envelope) return null;
  const products: NationalCatalogProduct[] = [];
  for (const row of envelope.result) {
    const product = parseProduct(row);
    if (!product) return null;
    products.push(product);
  }
  return { products };
}

function parseEtags(payload: unknown): NationalCatalogEtagsResponse | null {
  const envelope = asRecord(payload);
  const result = asRecord(envelope?.result);
  if (!envelope || envelope.apiversion !== 3 || !result) return null;
  const goodsCount = nonNegativeInteger(result.goods_count);
  const offset = nonNegativeInteger(result.offset);
  const lastProductNumber = nonNegativeInteger(result.last_product_number);
  const total = nonNegativeInteger(result.total);
  const rows = array(result.goods);
  if (
    goodsCount === null ||
    offset === null ||
    lastProductNumber === null ||
    total === null ||
    !rows ||
    rows.length > ETAGS_PAGE_LIMIT ||
    goodsCount !== rows.length ||
    lastProductNumber !== offset + goodsCount ||
    total < lastProductNumber
  ) {
    return null;
  }
  const goods: NationalCatalogEtagsResponse["goods"] = [];
  for (const row of rows) {
    const record = asRecord(row);
    const goodId = positiveInteger(record?.good_id);
    const etag = string(record?.etag);
    if (!record || goodId === null || etag === null || !/^[!-~]{1,512}$/.test(etag)) {
      return null;
    }
    goods.push({ goodId, etag });
  }
  return { goodsCount, offset, lastProductNumber, total, goods };
}

function parseProduct(value: unknown): NationalCatalogProduct | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = number(record.good_id);
  const name = optionalNullableString(record.good_name);
  const status = optionalNullableString(record.good_status);
  const identifiers = parseIdentifiers(record.identified_by);
  const categories = parseProductCategories(record.categories);
  const attributes = parseProductAttributes(record.good_attrs);
  if (
    id === null ||
    name === undefined ||
    status === undefined ||
    identifiers === null ||
    categories === null ||
    attributes === null
  ) {
    return null;
  }
  return { id, name, status, identifiers, categories, attributes, raw: record };
}

function parseIdentifiers(value: unknown): NationalCatalogProductIdentifier[] | null {
  const rows = array(value);
  if (!rows) return null;
  const identifiers: NationalCatalogProductIdentifier[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) return null;
    const identifier = string(record.value);
    const type = string(record.type);
    const multiplier = optionalNullableNumber(record.multiplier);
    const level = optionalNullableString(record.level);
    if (identifier === null || type === null || multiplier === undefined || level === undefined)
      return null;
    identifiers.push({ value: identifier, type, multiplier, level });
  }
  return identifiers;
}

function parseProductCategories(value: unknown): NationalCatalogProductCategory[] | null {
  const rows = array(value);
  if (!rows) return null;
  const categories: NationalCatalogProductCategory[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) return null;
    const id = number(record.cat_id);
    const name = string(record.cat_name);
    if (id === null || name === null) return null;
    categories.push({ id, name });
  }
  return categories;
}

function parseProductAttributes(value: unknown): NationalCatalogProductAttribute[] | null {
  const rows = array(value);
  if (!rows) return null;
  const attributes: NationalCatalogProductAttribute[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) return null;
    const id = number(record.attr_id);
    const name = string(record.attr_name);
    const attributeValue = string(record.attr_value);
    const valueId = optionalNullableNumber(record.value_id);
    const attributeValueId = optionalNullableNumber(record.attr_value_id);
    const valueType = optionalNullableString(record.attr_value_type);
    const groupId = optionalNullableNumber(record.attr_group_id);
    const groupName = optionalNullableString(record.attr_group_name);
    const locationId = optionalNullableNumber(record.location_id);
    const level = optionalNullableString(record.level);
    const gtin = optionalNullableString(record.gtin);
    const multiplier = optionalNullableNumber(record.multiplier);
    if (
      id === null ||
      name === null ||
      attributeValue === null ||
      valueId === undefined ||
      attributeValueId === undefined ||
      valueType === undefined ||
      groupId === undefined ||
      groupName === undefined ||
      locationId === undefined ||
      level === undefined ||
      gtin === undefined ||
      multiplier === undefined
    ) {
      return null;
    }
    attributes.push({
      id,
      name,
      value: attributeValue,
      valueId,
      attributeValueId,
      valueType,
      groupId,
      groupName,
      locationId,
      level,
      gtin,
      multiplier,
    });
  }
  return attributes;
}

function responseEnvelope(payload: unknown): { result: unknown[] } | null {
  const envelope = asRecord(payload);
  if (!envelope || envelope.apiversion !== 3 || !Array.isArray(envelope.result)) return null;
  return { result: envelope.result };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === undefined
    ? undefined
    : value === null || typeof value === "string"
      ? value
      : undefined;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === undefined
    ? undefined
    : value === null || (typeof value === "number" && Number.isFinite(value))
      ? value
      : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  return value === undefined ? null : nullableString(value);
}

function optionalNullableNumber(value: unknown): number | null | undefined {
  return value === undefined ? null : nullableNumber(value);
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberArray(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? value
    : null;
}

function optionalNumberArray(value: unknown): number[] | null {
  return value === undefined ? [] : numberArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function optionalStringArray(value: unknown): string[] | null {
  return value === undefined ? [] : stringArray(value);
}

function enumOrNull<T extends string>(value: unknown, values: readonly T[]): T | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function optionalEnumOrNull<T extends string>(
  value: unknown,
  values: readonly T[],
): T | null | undefined {
  return value === undefined ? null : enumOrNull(value, values);
}

function parseOptionalDependentAttributes(
  value: unknown,
): NationalCatalogDependentAttribute[] | null {
  if (value === undefined) return [];
  const rows = array(value);
  if (!rows) return null;
  const dependencies: NationalCatalogDependentAttribute[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) return null;
    if (!Object.hasOwn(record, "value") && !Object.hasOwn(record, "atters")) return null;
    const dependencyValue = optionalNullableString(record.value);
    const attributes = parseOptionalDependentAttributeRules(record.atters);
    if (dependencyValue === undefined || attributes === null) return null;
    dependencies.push({ value: dependencyValue, attributes });
  }
  return dependencies;
}

function parseOptionalDependentAttributeRules(
  value: unknown,
): NationalCatalogDependentAttributeRule[] | null {
  if (value === undefined) return [];
  const rows = array(value);
  if (!rows) return null;
  const attributes: NationalCatalogDependentAttributeRule[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) return null;
    const id = optionalNullableNumber(record.attr_id);
    const firstLayer = boolean(record.first_layer);
    const secondLayer = boolean(record.second_layer);
    const type = optionalNullableString(record.attr_type);
    if (id === undefined || firstLayer === null || secondLayer === null || type === undefined)
      return null;
    attributes.push({ id, firstLayer, secondLayer, type });
  }
  return attributes;
}
