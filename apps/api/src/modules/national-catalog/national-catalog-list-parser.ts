import type {
  NationalCatalogListPage,
  NationalCatalogListRequest,
  NationalCatalogListRow,
} from "./national-catalog.types";

const NATIONAL_CATALOG_LIST_TOTAL_LIMIT = 10_000;
const NATIONAL_CATALOG_LIST_PAGE_LIMIT = 1_000;

export function parseNationalCatalogListPage(
  payload: unknown,
  request: NationalCatalogListRequest,
): NationalCatalogListPage | null {
  const envelope = asRecord(payload);
  const result = asRecord(envelope?.result);
  if (!envelope || !result) return null;

  const goods = Array.isArray(result.goods) ? result.goods : null;
  const total = nonNegativeInteger(result.total);
  const offset = nonNegativeInteger(result.offset);
  const limit = positiveInteger(result.limit);
  if (
    !goods ||
    total === null ||
    total > NATIONAL_CATALOG_LIST_TOTAL_LIMIT ||
    offset === null ||
    offset !== request.offset ||
    limit === null ||
    limit > NATIONAL_CATALOG_LIST_PAGE_LIMIT ||
    limit !== request.limit ||
    goods.length > limit ||
    offset + goods.length > total ||
    (goods.length === 0 && offset < total)
  ) {
    return null;
  }

  const rows: NationalCatalogListRow[] = [];
  for (const value of goods) {
    const record = asRecord(value);
    if (!record) return null;
    const cardId = positiveInteger(record.good_id);
    const gtin = typeof record.gtin === "string" ? record.gtin : null;
    const name = optionalNullableString(record.good_name);
    const brand = optionalNullableString(record.brand_name);
    const status = optionalNullableString(record.good_status);
    const detailedStatuses = optionalDetailedStatuses(record.good_detailed_status);
    if (
      cardId === null ||
      gtin === null ||
      name === undefined ||
      brand === undefined ||
      status === undefined ||
      detailedStatuses === null
    ) {
      return null;
    }
    rows.push({
      cardId: String(cardId),
      gtins: [gtin],
      name,
      brand,
      status,
      detailedStatuses,
      raw: record,
    });
  }

  return {
    rows,
    nextOffset: offset + goods.length >= total ? null : offset + goods.length,
  };
}

export function normalizedDetailedStatuses(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value.map((status) => (status === "notsigned" ? "unsigned" : status));
}

function optionalDetailedStatuses(value: unknown): string[] | null {
  return value === undefined || value === null ? [] : normalizedDetailedStatuses(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function optionalNullableString(value: unknown): string | null | undefined {
  return value === undefined || value === null
    ? null
    : typeof value === "string"
      ? value
      : undefined;
}
