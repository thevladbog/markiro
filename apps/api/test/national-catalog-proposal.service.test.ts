import { describe, expect, it } from "vitest";

import { buildNationalCatalogImportEntries } from "../src/modules/national-catalog/national-catalog-proposal.service";

const schemaVersionId = "00000000-0000-4000-8000-000000000001";

describe("buildNationalCatalogImportEntries", () => {
  it("maps only exact schema attributes and preserves current values", () => {
    const result = buildNationalCatalogImportEntries({
      schemaVersionId,
      definitions: [
        {
          id: "20",
          label: "Тип",
          valueType: "enum",
          multiplicity: "one",
          unit: null,
          requirementRules: [],
          presetMode: "restricted",
          presets: [{ value: "КЕГ", label: "КЕГ" }],
        },
        {
          id: "21",
          label: "Объём",
          valueType: "decimal",
          multiplicity: "one",
          unit: null,
          requirementRules: [],
          presetMode: "none",
          presets: [],
        },
      ],
      currentValues: new Map([["20", { type: "enum", value: "БУТЫЛКА" }]]),
      sourceAttributes: [
        { id: 20, value: "КЕГ", unit: null },
        { id: 21, value: "50.0", unit: null },
        { id: 999, value: "ignored", unit: null },
      ],
      entryId: (attributeId) => `00000000-0000-4000-8000-${attributeId.padStart(12, "0")}`,
    });

    expect(result.ignored).toEqual([{ attributeId: "999", reason: "unmapped" }]);
    expect(result.entries).toEqual([
      expect.objectContaining({
        targetAttributeId: "20",
        currentValue: { type: "enum", value: "БУТЫЛКА" },
        proposedValue: { type: "enum", value: "КЕГ" },
        disposition: "convertible",
      }),
      expect.objectContaining({
        targetAttributeId: "21",
        currentValue: null,
        proposedValue: { type: "decimal", value: "50.0", unit: null },
        disposition: "convertible",
      }),
    ]);
  });

  it("does not guess invalid values or collapse duplicate scalar values", () => {
    const result = buildNationalCatalogImportEntries({
      schemaVersionId,
      definitions: [
        {
          id: "20",
          label: "Дата",
          valueType: "date",
          multiplicity: "one",
          unit: null,
          requirementRules: [],
          presetMode: "none",
          presets: [],
        },
        {
          id: "21",
          label: "Тип",
          valueType: "string",
          multiplicity: "one",
          unit: null,
          requirementRules: [],
          presetMode: "none",
          presets: [],
        },
      ],
      currentValues: new Map(),
      sourceAttributes: [
        { id: 20, value: "завтра", unit: null },
        { id: 21, value: "A", unit: null },
        { id: 21, value: "B", unit: null },
      ],
      entryId: () => "00000000-0000-4000-8000-000000000001",
    });
    expect(result.entries).toEqual([]);
    expect(result.ignored).toEqual([
      { attributeId: "20", reason: "invalid_value" },
      { attributeId: "21", reason: "ambiguous" },
    ]);
  });

  it("uses the card's exact reviewed unit and rejects absent or unknown units", () => {
    const definition = {
      id: "21",
      label: "Объём",
      valueType: "decimal" as const,
      multiplicity: "one" as const,
      unit: { canonical: "л", allowed: ["л", "мл"] },
      requirementRules: [],
      presetMode: "none" as const,
      presets: [],
    };
    const build = (unit: string | null) =>
      buildNationalCatalogImportEntries({
        schemaVersionId,
        definitions: [definition],
        currentValues: new Map(),
        sourceAttributes: [{ id: 21, value: "500", unit }],
        entryId: () => "00000000-0000-4000-8000-000000000001",
      });

    expect(build("мл").entries[0]).toMatchObject({
      proposedValue: { type: "decimal", value: "500", unit: "мл" },
    });
    expect(build(null).ignored).toEqual([{ attributeId: "21", reason: "invalid_value" }]);
    expect(build("кг").ignored).toEqual([{ attributeId: "21", reason: "invalid_value" }]);
  });

  it("adds stable fields only through one reviewed, versioned mapping", () => {
    const result = buildNationalCatalogImportEntries({
      schemaVersionId,
      definitions: [],
      currentValues: new Map(),
      currentStableFields: new Map([
        ["print_name", null],
        ["shelf_life_days", 30],
      ]),
      sourceName: "  Пиво светлое  ",
      sourceAttributes: [{ id: 22, value: "45", unit: null }],
      stableMappings: [
        {
          id: "00000000-0000-4000-8000-000000000101",
          sourceAttributeId: "good_name",
          targetField: "print_name",
          conversion: { kind: "string_trim" },
          mappingVersion: 2,
        },
        {
          id: "00000000-0000-4000-8000-000000000102",
          sourceAttributeId: "22",
          targetField: "shelf_life_days",
          conversion: { kind: "positive_integer" },
          mappingVersion: 1,
        },
      ],
      entryId: (key) =>
        key === "stable:print_name"
          ? "00000000-0000-4000-8000-000000000201"
          : "00000000-0000-4000-8000-000000000202",
    });

    expect(result.entries).toEqual([
      expect.objectContaining({
        target: "stable_field",
        targetField: "print_name",
        mappingVersion: 2,
        currentValue: null,
        proposedValue: "Пиво светлое",
      }),
      expect.objectContaining({
        target: "stable_field",
        targetField: "shelf_life_days",
        mappingVersion: 1,
        currentValue: 30,
        proposedValue: 45,
      }),
    ]);
  });

  it("does not guess a stable target when persisted mappings conflict", () => {
    const result = buildNationalCatalogImportEntries({
      schemaVersionId,
      definitions: [],
      currentValues: new Map(),
      currentStableFields: new Map([["name", "Старое имя"]]),
      sourceName: "Новое имя",
      sourceAttributes: [{ id: 22, value: "Другое имя", unit: null }],
      stableMappings: [
        {
          id: "00000000-0000-4000-8000-000000000101",
          sourceAttributeId: "good_name",
          targetField: "name",
          conversion: { kind: "identity" },
          mappingVersion: 1,
        },
        {
          id: "00000000-0000-4000-8000-000000000102",
          sourceAttributeId: "22",
          targetField: "name",
          conversion: { kind: "identity" },
          mappingVersion: 1,
        },
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.ignored).toEqual([
      { attributeId: "22", reason: "unmapped" },
      { attributeId: "stable:name", reason: "ambiguous" },
    ]);
  });

  it("rejects stable values outside the product write bounds", () => {
    const result = buildNationalCatalogImportEntries({
      schemaVersionId,
      definitions: [],
      currentValues: new Map(),
      sourceName: "x".repeat(201),
      sourceAttributes: [{ id: 22, value: "3651", unit: null }],
      stableMappings: [
        {
          id: "00000000-0000-4000-8000-000000000101",
          sourceAttributeId: "good_name",
          targetField: "name",
          conversion: { kind: "identity" },
          mappingVersion: 1,
        },
        {
          id: "00000000-0000-4000-8000-000000000102",
          sourceAttributeId: "22",
          targetField: "shelf_life_days",
          conversion: { kind: "positive_integer" },
          mappingVersion: 1,
        },
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.ignored).toEqual([
      { attributeId: "22", reason: "unmapped" },
      { attributeId: "stable:name", reason: "invalid_value" },
      { attributeId: "stable:shelf_life_days", reason: "invalid_value" },
    ]);
  });
});
