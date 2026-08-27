import { describe, expect, it } from "vitest";

import {
  createInventoryDocumentRegistry,
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
  it("advertises only the two fixture-backed GISMT inventory documents", () => {
    expect(INVENTORY_DOCUMENT_FORMATS).toEqual([
      {
        id: "inventory_xml_gismt_aggregation",
        version: 1,
        label: "[XML][ГИСМТ] Формирование упаковки",
        extension: "xml",
        mimeType: "application/xml; charset=utf-8",
        requiredSourceCategories: ["verified", "protected", "newBoxes"],
        supportsParts: false,
        availability: "available",
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

  it("rejects duplicate format ids during registry construction", () => {
    expect(() =>
      createInventoryDocumentRegistry([
        availableDescriptor,
        { ...availableDescriptor, version: 3 },
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "InventoryDocumentRegistryError",
        code: "DUPLICATE_FORMAT_ID",
      }),
    );
  });

  it("resolves only the exact advertised version", () => {
    const registry = createInventoryDocumentRegistry([availableDescriptor]);

    expect(registry.resolve("synthetic_current_stock_csv", 2)).toEqual(availableDescriptor);
    expect(() => registry.resolve("unknown", 1)).toThrowError(
      expect.objectContaining({ code: "FORMAT_UNKNOWN" }),
    );
    expect(() => registry.resolve("synthetic_current_stock_csv", 1)).toThrowError(
      expect.objectContaining({ code: "FORMAT_SUPERSEDED" }),
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
