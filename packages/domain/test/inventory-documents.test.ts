import { describe, expect, it } from "vitest";

import {
  createInventoryDocumentRegistry,
  getInventoryDocumentFormat,
  getRegisteredInventoryDocumentFormat,
  INVENTORY_DOCUMENT_FORMATS,
  InventoryDocumentRegistryError,
  inventoryDocumentFormatDescriptorSchema,
  type InventoryDocumentFormatDescriptor,
  type InventoryDocumentSourceCategory,
} from "../src/inventory/documents.js";

const availableDescriptor: InventoryDocumentFormatDescriptor = {
  id: "synthetic_current_stock_csv",
  version: 2,
  label: "Synthetic current stock",
  extension: "csv",
  mimeType: "text/csv; charset=utf-8",
  requiredSourceCategories: ["verified", "protected"],
  supportsParts: true,
  availability: "available",
};

describe("inventory document format registry", () => {
  it("advertises the current operational document catalog", () => {
    expect(INVENTORY_DOCUMENT_FORMATS).toEqual([
      {
        id: "inventory_xml_gismt_aggregation",
        version: 2,
        label: "[XML][ГИСМТ] Формирование упаковки",
        extension: "xml",
        mimeType: "application/xml; charset=utf-8",
        requiredSourceCategories: ["verified", "protected", "newBoxes"],
        supportsParts: false,
        availability: "available",
        requiresOrganizationInn: true,
      },
      {
        id: "inventory_xml_gismt_disaggregation",
        version: 1,
        label: "[XML][ГИСМТ] Расформирование упаковки",
        extension: "xml",
        mimeType: "application/xml; charset=utf-8",
        requiredSourceCategories: ["verified", "protected", "newBoxes"],
        supportsParts: false,
        availability: "available",
        requiresOrganizationInn: true,
      },
      {
        id: "inventory_txt_write_off",
        version: 1,
        label: "[TXT] Коды к списанию",
        extension: "txt",
        mimeType: "text/plain; charset=utf-8",
        requiredSourceCategories: ["writeOffCandidates", "protected"],
        supportsParts: false,
        availability: "available",
      },
      {
        id: "inventory_csv_write_off",
        version: 1,
        label: "[CSV] Коды к списанию",
        extension: "csv",
        mimeType: "text/csv; charset=utf-8",
        requiredSourceCategories: ["writeOffCandidates", "protected"],
        supportsParts: false,
        availability: "available",
      },
      {
        id: "inventory_csv_current_stock",
        version: 1,
        label: "[CSV] Коды на учёт",
        extension: "csv",
        mimeType: "text/csv; charset=utf-8",
        requiredSourceCategories: ["verified", "protected"],
        supportsParts: false,
        availability: "available",
      },
      {
        id: "inventory_csv_final_box_contents",
        version: 1,
        label: "[CSV] Состав итоговых коробов",
        extension: "csv",
        mimeType: "text/csv; charset=utf-8",
        requiredSourceCategories: ["verified", "protected", "newBoxes"],
        supportsParts: false,
        availability: "available",
      },
      {
        id: "inventory_txt_final_boxes",
        version: 1,
        label: "[TXT] Номера итоговых коробов",
        extension: "txt",
        mimeType: "text/plain; charset=utf-8",
        requiredSourceCategories: ["verified", "protected", "newBoxes"],
        supportsParts: false,
        availability: "available",
      },
      {
        id: "inventory_csv_balances_by_production_date",
        version: 1,
        label: "[CSV] Остатки по датам производства",
        extension: "csv",
        mimeType: "text/csv; charset=utf-8",
        requiredSourceCategories: ["verified", "protected", "newBoxes"],
        supportsParts: false,
        availability: "available",
      },
    ]);
    expect(Object.isFrozen(INVENTORY_DOCUMENT_FORMATS)).toBe(true);
  });

  it("strictly validates the complete descriptor boundary", () => {
    expect(inventoryDocumentFormatDescriptorSchema.parse(availableDescriptor)).toEqual(
      availableDescriptor,
    );
    expect(() =>
      inventoryDocumentFormatDescriptorSchema.parse({
        ...availableDescriptor,
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      inventoryDocumentFormatDescriptorSchema.parse({
        ...availableDescriptor,
        requiredSourceCategories: ["verified", "not-a-source-category"],
      }),
    ).toThrow();
  });

  it("registers each id and version once", () => {
    const legacy = { ...availableDescriptor, version: 1, availability: "unavailable" } as const;
    const current = { ...availableDescriptor, version: 2, availability: "available" } as const;

    expect(() => createInventoryDocumentRegistry([legacy, { ...legacy }])).toThrowError(
      expect.objectContaining({
        name: "InventoryDocumentRegistryError",
        code: "DUPLICATE_FORMAT_VERSION",
      }),
    );
    expect(() =>
      createInventoryDocumentRegistry([current, { ...current, version: 3 }]),
    ).toThrowError(
      expect.objectContaining({
        name: "InventoryDocumentRegistryError",
        code: "DUPLICATE_FORMAT_ID",
      }),
    );
  });

  it("uses the current version for new selections and registered versions for stored runs", () => {
    const legacy = { ...availableDescriptor, version: 1, availability: "unavailable" } as const;
    const current = { ...availableDescriptor, version: 2, availability: "available" } as const;
    const registry = createInventoryDocumentRegistry([legacy, current]);

    expect(registry.listAvailable()).toEqual([current]);
    expect(registry.resolve(current.id, 2)).toEqual(current);
    expect(() => registry.resolve(current.id, 1)).toThrowError(
      expect.objectContaining({ code: "FORMAT_SUPERSEDED" }),
    );
    expect(registry.resolveRegistered(current.id, 1)).toEqual(legacy);
    expect(() => registry.resolve("unknown", 1)).toThrowError(
      expect.objectContaining({ code: "FORMAT_UNKNOWN" }),
    );
    expect(() => registry.resolveRegistered("synthetic_current_stock_csv", 3)).toThrowError(
      expect.objectContaining({ code: "FORMAT_UNKNOWN" }),
    );
  });

  it("keeps the legacy format helper as an exact registered lookup", () => {
    expect(getInventoryDocumentFormat("inventory_xml_gismt_aggregation", 1)).toMatchObject({
      id: "inventory_xml_gismt_aggregation",
      version: 1,
      availability: "unavailable",
    });
    expect(getRegisteredInventoryDocumentFormat("inventory_xml_gismt_aggregation", 1)).toEqual(
      getInventoryDocumentFormat("inventory_xml_gismt_aggregation", 1),
    );
  });

  it("does not advertise or resolve unavailable formats", () => {
    const registry = createInventoryDocumentRegistry([
      availableDescriptor,
      {
        ...availableDescriptor,
        id: "synthetic_unapproved_xml",
        version: 1,
        extension: "xml",
        mimeType: "application/xml; charset=utf-8",
        availability: "unavailable",
      },
    ]);

    expect(registry.listAvailable()).toEqual([availableDescriptor]);
    expect(() => registry.resolve("synthetic_unapproved_xml", 1)).toThrowError(
      expect.objectContaining({ code: "FORMAT_UNAVAILABLE" }),
    );
  });

  it("copies and deeply freezes descriptors so callers cannot change registry semantics", () => {
    const mutableCategories: InventoryDocumentSourceCategory[] = ["verified"];
    const mutable: InventoryDocumentFormatDescriptor = {
      ...availableDescriptor,
      requiredSourceCategories: mutableCategories,
    };
    const registry = createInventoryDocumentRegistry([mutable]);
    mutableCategories.push("unknown");
    mutable.label = "Changed outside";

    const listed = registry.listAvailable()[0];
    expect(listed).toEqual({
      ...availableDescriptor,
      requiredSourceCategories: ["verified"],
    });
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed?.requiredSourceCategories)).toBe(true);
    expect(() =>
      (listed?.requiredSourceCategories as string[] | undefined)?.push("unknown"),
    ).toThrow(TypeError);
  });

  it("reports stable domain error identities", () => {
    const error = new InventoryDocumentRegistryError("FORMAT_UNKNOWN");
    expect(error).toMatchObject({
      name: "InventoryDocumentRegistryError",
      message: "FORMAT_UNKNOWN",
      code: "FORMAT_UNKNOWN",
    });
  });
});
