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
});

export type InventoryDocumentFormatDescriptor = z.infer<
  typeof inventoryDocumentFormatDescriptorSchema
>;

export type InventoryDocumentRegistryErrorCode =
  | "INVALID_DESCRIPTOR"
  | "DUPLICATE_FORMAT_ID"
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
  const byId = new Map<string, InventoryDocumentFormatDescriptor>();
  for (const value of input) {
    const descriptor = immutableDescriptor(value);
    if (byId.has(descriptor.id)) {
      throw new InventoryDocumentRegistryError("DUPLICATE_FORMAT_ID");
    }
    byId.set(descriptor.id, descriptor);
  }

  const available = Object.freeze(
    [...byId.values()].filter((descriptor) => descriptor.availability === "available"),
  );

  return Object.freeze({
    listAvailable: () => available,
    resolve: (id: string, version: number) => {
      const descriptor = byId.get(id);
      if (!descriptor) throw new InventoryDocumentRegistryError("FORMAT_UNKNOWN");
      if (descriptor.version !== version) {
        throw new InventoryDocumentRegistryError("FORMAT_SUPERSEDED");
      }
      if (descriptor.availability !== "available") {
        throw new InventoryDocumentRegistryError("FORMAT_UNAVAILABLE");
      }
      return descriptor;
    },
  });
}

export const INVENTORY_DOCUMENT_FORMATS = Object.freeze([
  Object.freeze({
    id: "inventory_xml_gismt_aggregation",
    version: 1,
    label: "[XML][ГИСМТ] Формирование упаковки",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
    requiredSourceCategories: Object.freeze(["verified", "protected", "newBoxes"] as const),
    supportsParts: false,
    availability: "available",
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
  }),
] as const satisfies readonly InventoryDocumentFormatDescriptor[]);

export const inventoryDocumentRegistry = createInventoryDocumentRegistry(
  INVENTORY_DOCUMENT_FORMATS,
);

export function getInventoryDocumentFormat(
  id: string,
  version: number,
): InventoryDocumentFormatDescriptor {
  return inventoryDocumentRegistry.resolve(id, version);
}
