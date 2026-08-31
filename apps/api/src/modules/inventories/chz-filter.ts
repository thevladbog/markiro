import {
  INVENTORY_CHZ_STATUSES,
  normalizeToGtin14,
  type InventoryChzStatus,
} from "@markiro/domain";

import { ChzImportError } from "./chz-tabular-reader";

export interface ChzFilter {
  status: InventoryChzStatus;
  packagingType: "UNIT";
  includedGtin14: string;
}

function fieldValue(source: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...source.matchAll(new RegExp(`"${escaped}"\\s*=\\s*([^,)]*)`, "g"))];
  if (matches.length !== 1) throw new ChzImportError("CHZ_FILTER_INVALID", 1);
  return matches[0]![1]!.trim();
}

function dispenserFieldValue(source: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...source.matchAll(new RegExp(`(?:^|,\\s*)${escaped}\\s*=\\s*([^,)]*)`, "g"))];
  if (matches.length !== 1) throw new ChzImportError("CHZ_FILTER_INVALID", 1);
  return matches[0]![1]!.trim();
}

function parseFields(
  source: string,
  fields: { status: string; packaging: string; includedGtin: string },
  value: (source: string, field: string) => string,
): ChzFilter {
  const rawStatus = value(source, fields.status);
  if (!INVENTORY_CHZ_STATUSES.some((status) => status === rawStatus)) {
    throw new ChzImportError("CHZ_FILTER_INVALID", 1);
  }
  const rawPackaging = value(source, fields.packaging);
  if (rawPackaging !== "[UNIT]") {
    throw new ChzImportError("CHZ_FILTER_PACKAGING_MISMATCH", 1);
  }
  const rawIncludedGtin = value(source, fields.includedGtin);
  const match = /^\[(\d{8}|\d{12,14})\]$/.exec(rawIncludedGtin);
  if (match === null) throw new ChzImportError("CHZ_FILTER_INVALID", 1);
  let includedGtin14: string;
  try {
    includedGtin14 = normalizeToGtin14(match[1]!);
  } catch {
    throw new ChzImportError("CHZ_FILTER_INVALID", 1);
  }
  return {
    status: rawStatus as InventoryChzStatus,
    packagingType: "UNIT",
    includedGtin14,
  };
}

export function parseChzFilter(source: string): ChzFilter {
  const trimmed = source.trim();
  if (trimmed.startsWith("Фильтр(") && trimmed.endsWith(")")) {
    return parseFields(
      trimmed,
      {
        status: "Статусы кодов",
        packaging: "Типы упаковок",
        includedGtin: "Включая коды товаров",
      },
      fieldValue,
    );
  }
  if (trimmed.startsWith("Filter(") && trimmed.endsWith(")")) {
    return parseFields(
      trimmed.slice("Filter(".length, -1),
      { status: "status", packaging: "packageType", includedGtin: "includeGtin" },
      dispenserFieldValue,
    );
  }
  throw new ChzImportError("CHZ_FILTER_INVALID", 1);
}
