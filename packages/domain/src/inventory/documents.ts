import { z } from "zod";

export const INVENTORY_DOCUMENT_SOURCE_CATEGORIES = [
  "expected",
  "verified",
  "writeOffCandidates",
  "protected",
  "ineligible",
  "unknown",
  "oldBoxes",
  "newBoxes",
  "observedDateGroups",
] as const;

export type InventoryDocumentSourceCategory = (typeof INVENTORY_DOCUMENT_SOURCE_CATEGORIES)[number];

export const INVENTORY_DOCUMENT_FORMAT_AVAILABILITIES = ["available", "unavailable"] as const;
export type InventoryDocumentFormatAvailability =
  (typeof INVENTORY_DOCUMENT_FORMAT_AVAILABILITIES)[number];

export const INVENTORY_DOCUMENT_MIME_TYPE_PATTERN =
  "^[^\\s/;]+\\/[^\\s/;]+(?:; charset=[a-z0-9-]+)?$";

export const inventoryDocumentFormatDescriptorSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  version: z.number().int().min(1).max(2_147_483_647),
  label: z.string().trim().min(1).max(200),
  extension: z.string().regex(/^[a-z0-9]{1,16}$/),
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(new RegExp(INVENTORY_DOCUMENT_MIME_TYPE_PATTERN)),
  requiredSourceCategories: z
    .array(z.enum(INVENTORY_DOCUMENT_SOURCE_CATEGORIES))
    .min(1)
    .max(INVENTORY_DOCUMENT_SOURCE_CATEGORIES.length)
    .refine((categories) => new Set(categories).size === categories.length, {
      message: "requiredSourceCategories must not contain duplicates",
    })
    .readonly(),
  supportsParts: z.boolean(),
  availability: z.enum(INVENTORY_DOCUMENT_FORMAT_AVAILABILITIES),
  requiresOrganizationInn: z.literal(true).optional(),
});

export type InventoryDocumentFormatDescriptor = z.infer<
  typeof inventoryDocumentFormatDescriptorSchema
>;

export type InventoryDocumentRegistryErrorCode =
  | "INVALID_DESCRIPTOR"
  | "DUPLICATE_FORMAT_ID"
  | "DUPLICATE_FORMAT_VERSION"
  | "FORMAT_UNKNOWN"
  | "FORMAT_SUPERSEDED"
  | "FORMAT_UNAVAILABLE";

export class InventoryDocumentRegistryError extends Error {
  constructor(readonly code: InventoryDocumentRegistryErrorCode) {
    super(code);
    this.name = "InventoryDocumentRegistryError";
  }
}

export interface InventoryDocumentRegistry {
  listAvailable(): readonly InventoryDocumentFormatDescriptor[];
  resolve(id: string, version: number): InventoryDocumentFormatDescriptor;
  resolveRegistered(id: string, version: number): InventoryDocumentFormatDescriptor;
}

function formatKey(id: string, version: number): string {
  return `${id}@${version}`;
}

function immutableDescriptor(value: unknown): InventoryDocumentFormatDescriptor {
  const parsed = inventoryDocumentFormatDescriptorSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryDocumentRegistryError("INVALID_DESCRIPTOR");
  }
  return Object.freeze({
    ...parsed.data,
    requiredSourceCategories: Object.freeze([...parsed.data.requiredSourceCategories]),
  });
}

export function createInventoryDocumentRegistry(
  input: readonly unknown[],
): InventoryDocumentRegistry {
  const byRegisteredVersion = new Map<string, InventoryDocumentFormatDescriptor>();
  const registeredIds = new Set<string>();
  const currentById = new Map<string, InventoryDocumentFormatDescriptor>();
  for (const value of input) {
    const descriptor = immutableDescriptor(value);
    const key = formatKey(descriptor.id, descriptor.version);
    if (byRegisteredVersion.has(key)) {
      throw new InventoryDocumentRegistryError("DUPLICATE_FORMAT_VERSION");
    }
    if (descriptor.availability === "available" && currentById.has(descriptor.id)) {
      throw new InventoryDocumentRegistryError("DUPLICATE_FORMAT_ID");
    }
    byRegisteredVersion.set(key, descriptor);
    registeredIds.add(descriptor.id);
    if (descriptor.availability === "available") {
      currentById.set(descriptor.id, descriptor);
    }
  }

  const available = Object.freeze([...currentById.values()]);

  return Object.freeze({
    listAvailable: () => available,
    resolve: (id: string, version: number) => {
      const current = currentById.get(id);
      if (current) {
        if (current.version !== version) {
          throw new InventoryDocumentRegistryError("FORMAT_SUPERSEDED");
        }
        return current;
      }
      if (registeredIds.has(id)) {
        throw new InventoryDocumentRegistryError("FORMAT_UNAVAILABLE");
      }
      throw new InventoryDocumentRegistryError("FORMAT_UNKNOWN");
    },
    resolveRegistered: (id: string, version: number) => {
      const descriptor = byRegisteredVersion.get(formatKey(id, version));
      if (!descriptor) {
        throw new InventoryDocumentRegistryError("FORMAT_UNKNOWN");
      }
      return descriptor;
    },
  });
}

const legacyAggregationV1 = Object.freeze({
  id: "inventory_xml_gismt_aggregation",
  version: 1,
  label: "[XML][ГИСМТ] Формирование упаковки",
  extension: "xml",
  mimeType: "application/xml; charset=utf-8",
  requiredSourceCategories: Object.freeze(["verified", "protected", "newBoxes"] as const),
  supportsParts: false,
  availability: "unavailable",
  requiresOrganizationInn: true,
} as const satisfies InventoryDocumentFormatDescriptor);

export const INVENTORY_DOCUMENT_FORMATS = Object.freeze([
  Object.freeze({
    id: "inventory_xml_gismt_aggregation",
    version: 2,
    label: "[XML][ГИСМТ] Формирование упаковки",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
    requiredSourceCategories: Object.freeze(["verified", "protected", "newBoxes"] as const),
    supportsParts: false,
    availability: "available",
    requiresOrganizationInn: true,
  }),
  Object.freeze({
    id: "inventory_xml_gismt_disaggregation",
    version: 1,
    label: "[XML][ГИСМТ] Расформирование упаковки",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
    requiredSourceCategories: Object.freeze(["verified", "protected", "newBoxes"] as const),
    supportsParts: false,
    availability: "available",
    requiresOrganizationInn: true,
  }),
  Object.freeze({
    id: "inventory_txt_write_off",
    version: 1,
    label: "[TXT] Коды к списанию",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    requiredSourceCategories: Object.freeze(["writeOffCandidates", "protected"] as const),
    supportsParts: false,
    availability: "available",
  }),
  Object.freeze({
    id: "inventory_csv_write_off",
    version: 1,
    label: "[CSV] Коды к списанию",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    requiredSourceCategories: Object.freeze(["writeOffCandidates", "protected"] as const),
    supportsParts: false,
    availability: "available",
  }),
  Object.freeze({
    id: "inventory_csv_current_stock",
    version: 1,
    label: "[CSV] Коды на учёт",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    requiredSourceCategories: Object.freeze(["verified", "protected"] as const),
    supportsParts: false,
    availability: "available",
  }),
  Object.freeze({
    id: "inventory_csv_final_box_contents",
    version: 1,
    label: "[CSV] Состав итоговых коробов",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    requiredSourceCategories: Object.freeze(["verified", "protected", "newBoxes"] as const),
    supportsParts: false,
    availability: "available",
  }),
  Object.freeze({
    id: "inventory_txt_final_boxes",
    version: 1,
    label: "[TXT] Номера итоговых коробов",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    requiredSourceCategories: Object.freeze(["verified", "protected", "newBoxes"] as const),
    supportsParts: false,
    availability: "available",
  }),
  Object.freeze({
    id: "inventory_csv_balances_by_production_date",
    version: 1,
    label: "[CSV] Остатки по датам производства",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    requiredSourceCategories: Object.freeze(["verified", "protected", "newBoxes"] as const),
    supportsParts: false,
    availability: "available",
  }),
] as const satisfies readonly InventoryDocumentFormatDescriptor[]);

export const inventoryDocumentRegistry = createInventoryDocumentRegistry([
  legacyAggregationV1,
  ...INVENTORY_DOCUMENT_FORMATS,
]);

export function getRegisteredInventoryDocumentFormat(
  id: string,
  version: number,
): InventoryDocumentFormatDescriptor {
  return inventoryDocumentRegistry.resolveRegistered(id, version);
}

export function getInventoryDocumentFormat(
  id: string,
  version: number,
): InventoryDocumentFormatDescriptor {
  return getRegisteredInventoryDocumentFormat(id, version);
}
