import {
  dadataAddressSuggestionSchema,
  dadataBankSuggestionSchema,
  dadataOrganizationSuggestionSchema,
  type DadataAddressSuggestion,
  type DadataBankSuggestion,
  type DadataOrganizationSuggestion,
} from "@markiro/platform-contracts";

export function mapDadataOrganizationSuggestions(
  payload: unknown,
): DadataOrganizationSuggestion[] | null {
  const suggestions = providerSuggestions(payload);
  if (!suggestions) return null;
  return suggestions.flatMap((suggestion) => {
    const value = stringValue(suggestion.value);
    const data = recordValue(suggestion.data);
    const type = stringValue(data?.type);
    const inn = stringValue(data?.inn);
    const ogrnValue = stringValue(data?.ogrn);
    const name = recordValue(data?.name);
    const fullName = stringValue(name?.full_with_opf) ?? value;
    const displayName = stringValue(name?.short_with_opf) ?? value;
    if (!value || !data || !inn || !fullName || !displayName || !ogrnValue) return [];
    if (type !== "LEGAL" && type !== "INDIVIDUAL") return [];
    const kind = type === "LEGAL" ? "legal_entity" : "sole_proprietor";
    const address = recordValue(data.address);
    const legalAddress = address
      ? mapAddress(stringValue(address.value), recordValue(address.data))
      : null;
    const mapped = dadataOrganizationSuggestionSchema.safeParse({
      value,
      kind,
      fullName,
      displayName,
      inn,
      kpp: type === "LEGAL" ? stringValue(data.kpp) : null,
      ogrn: type === "LEGAL" ? ogrnValue : null,
      ogrnip: type === "INDIVIDUAL" ? ogrnValue : null,
      legalAddress,
    });
    return mapped.success ? [mapped.data] : [];
  });
}

export function mapDadataAddressSuggestions(payload: unknown): DadataAddressSuggestion[] | null {
  const suggestions = providerSuggestions(payload);
  if (!suggestions) return null;
  return suggestions.flatMap((suggestion) => {
    const mapped = mapAddress(stringValue(suggestion.value), recordValue(suggestion.data));
    if (!mapped) return [];
    const parsed = dadataAddressSuggestionSchema.safeParse(mapped);
    return parsed.success ? [parsed.data] : [];
  });
}

export function mapDadataBankSuggestions(payload: unknown): DadataBankSuggestion[] | null {
  const suggestions = providerSuggestions(payload);
  if (!suggestions) return null;
  return suggestions.flatMap((suggestion) => {
    const value = stringValue(suggestion.value);
    const data = recordValue(suggestion.data);
    const bic = stringValue(data?.bic);
    const name = recordValue(data?.name);
    const bankName = stringValue(name?.payment) ?? stringValue(name?.short) ?? value;
    if (!value || !data || !bic || !/^\d{9}$/.test(bic) || !bankName) return [];
    const correspondentAccount = stringValue(data.correspondent_account);
    const mapped = dadataBankSuggestionSchema.safeParse({
      value,
      bic,
      bankName,
      correspondentAccount:
        correspondentAccount && /^\d{20}$/.test(correspondentAccount) ? correspondentAccount : null,
    });
    return mapped.success ? [mapped.data] : [];
  });
}

function mapAddress(
  value: string | null,
  data: Record<string, unknown> | null,
): DadataAddressSuggestion | null {
  if (!value) return null;
  return {
    value,
    fiasId: stringValue(data?.fias_id),
    kladrId: stringValue(data?.kladr_id),
    postalCode: stringValue(data?.postal_code),
    region: stringValue(data?.region_with_type) ?? stringValue(data?.region),
    city: stringValue(data?.city_with_type) ?? stringValue(data?.city),
    settlement: stringValue(data?.settlement_with_type) ?? stringValue(data?.settlement),
    street: stringValue(data?.street_with_type) ?? stringValue(data?.street),
    house: stringValue(data?.house),
    block: stringValue(data?.block),
    flat: stringValue(data?.flat),
    latitude: stringValue(data?.geo_lat),
    longitude: stringValue(data?.geo_lon),
    qualityCode: scalarString(data?.qc),
    completenessCode: scalarString(data?.qc_complete),
  };
}

function providerSuggestions(payload: unknown): Record<string, unknown>[] | null {
  const record = recordValue(payload);
  if (!record || !Array.isArray(record.suggestions)) return null;
  const suggestions: Record<string, unknown>[] = [];
  for (const value of record.suggestions) {
    const suggestion = recordValue(value);
    if (!suggestion) return null;
    suggestions.push(suggestion);
  }
  return suggestions;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return stringValue(value);
}
