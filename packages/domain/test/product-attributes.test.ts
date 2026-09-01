import { describe, expect, it } from "vitest";

import {
  categorySchemaDefinitionSchema,
  evaluateProductReadiness,
  isAttributeRequired,
  parseCategorySchemaDefinition,
  validateProductAttributeValue,
  type CategoryAttributeDefinition,
} from "../src/index.js";

const hasSweetenerDefinition: CategoryAttributeDefinition = {
  id: "hasSweetener",
  label: "Содержит подсластитель",
  valueType: "boolean",
  multiplicity: "one",
  unit: null,
  requirementRules: [{ layer: "circulation", level: "mandatory", when: null }],
  presetMode: "none",
  presets: [],
};

const sweetenerNameDefinition: CategoryAttributeDefinition = {
  id: "sweetenerName",
  label: "Наименование подсластителя",
  valueType: "string_list",
  multiplicity: "many",
  unit: null,
  requirementRules: [
    {
      layer: "circulation",
      level: "mandatory",
      when: { attributeId: "hasSweetener", operator: "equals", value: true },
    },
  ],
  presetMode: "none",
  presets: [],
};

function schema(attributes: CategoryAttributeDefinition[]) {
  return {
    formatVersion: 2 as const,
    categoryId: "234225",
    scopeKey: "category:234225|tnved:none",
    attributes,
  };
}

describe("categorySchemaDefinitionSchema", () => {
  it("accepts version 2 requirement rules with reviewed units", () => {
    const parsed = categorySchemaDefinitionSchema.parse(
      schema([
        hasSweetenerDefinition,
        sweetenerNameDefinition,
        {
          id: "volume",
          label: "Объём",
          valueType: "decimal",
          multiplicity: "one",
          unit: { canonical: "l", allowed: ["l", "ml"] },
          requirementRules: [{ layer: "code_ordering", level: "mandatory", when: null }],
          presetMode: "none",
          presets: [],
        },
      ]),
    );

    expect(parsed.formatVersion).toBe(2);
    expect(parsed.attributes[2]?.unit).toEqual({ canonical: "l", allowed: ["l", "ml"] });
  });

  it.each([
    {
      name: "unknown trigger",
      definition: schema([
        {
          ...sweetenerNameDefinition,
          requirementRules: [
            {
              layer: "circulation" as const,
              level: "mandatory" as const,
              when: { attributeId: "missing", operator: "equals" as const, value: true },
            },
          ],
        },
      ]),
      message: "Unknown condition attribute missing",
    },
    {
      name: "includes against a scalar trigger",
      definition: schema([
        hasSweetenerDefinition,
        {
          ...sweetenerNameDefinition,
          requirementRules: [
            {
              layer: "circulation" as const,
              level: "mandatory" as const,
              when: {
                attributeId: "hasSweetener",
                operator: "includes" as const,
                value: "yes",
              },
            },
          ],
        },
      ]),
      message: "Condition is incompatible with trigger hasSweetener",
    },
    {
      name: "duplicate requirement rule",
      definition: schema([
        {
          ...hasSweetenerDefinition,
          requirementRules: [
            { layer: "circulation" as const, level: "mandatory" as const, when: null },
            { layer: "circulation" as const, level: "mandatory" as const, when: null },
          ],
        },
      ]),
      message: "Duplicate requirement rule",
    },
    {
      name: "unit on a non-decimal attribute",
      definition: schema([
        { ...hasSweetenerDefinition, unit: { canonical: "kg", allowed: ["kg"] } },
      ]),
      message: "Only decimal attributes can declare units",
    },
    {
      name: "duplicate allowed unit",
      definition: schema([
        {
          id: "weight",
          label: "Вес",
          valueType: "decimal" as const,
          multiplicity: "one" as const,
          unit: { canonical: "kg", allowed: ["kg", "kg"] },
          requirementRules: [],
          presetMode: "none",
          presets: [],
        },
      ]),
      message: "Allowed units must be unique",
    },
    {
      name: "presets declared in none mode",
      definition: schema([
        {
          id: "comment",
          label: "Комментарий",
          valueType: "string" as const,
          multiplicity: "one" as const,
          unit: null,
          requirementRules: [],
          presetMode: "none" as const,
          presets: [{ value: "one", label: "Один" }],
        },
      ]),
      message: "Preset mode none cannot declare presets",
    },
  ])("rejects $name", ({ definition, message }) => {
    const result = categorySchemaDefinitionSchema.safeParse(definition);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(message);
    }
  });

  it("rejects the legacy format at the version 2 persistence boundary", () => {
    expect(
      categorySchemaDefinitionSchema.safeParse({
        categoryId: "legacy",
        scopeKey: "category:legacy|tnved:none",
        attributes: [],
      }).success,
    ).toBe(false);
  });
});

describe("parseCategorySchemaDefinition", () => {
  it("reports current-version errors without falling back to the legacy schema", () => {
    const parse = () =>
      parseCategorySchemaDefinition({
        formatVersion: 1,
        categoryId: "versioned",
        scopeKey: "category:versioned|tnved:none",
        attributes: [],
      });

    expect(parse).toThrow();
    try {
      parse();
    } catch (error) {
      expect(error).toMatchObject({
        issues: [expect.objectContaining({ path: ["formatVersion"] })],
      });
    }
  });

  it("normalizes legacy layers and conditions without rewriting their semantics", () => {
    const parsed = parseCategorySchemaDefinition({
      categoryId: "legacy",
      scopeKey: "category:legacy|tnved:none",
      attributes: [
        {
          id: "animalSpecies",
          label: "Вид животного",
          valueType: "enum_list",
          multiplicity: "many",
          requiredLayers: ["code_ordering"],
          requiredWhen: [],
          presets: [{ value: "cow", label: "Корова" }],
        },
        {
          id: "vetDocumentNumber",
          label: "Номер ВСД",
          valueType: "string",
          multiplicity: "one",
          requiredLayers: [],
          requiredWhen: [{ attributeId: "animalSpecies", operator: "includes", value: "cow" }],
          presets: [],
        },
      ],
    });

    expect(parsed).toEqual({
      formatVersion: 2,
      categoryId: "legacy",
      scopeKey: "category:legacy|tnved:none",
      attributes: [
        {
          id: "animalSpecies",
          label: "Вид животного",
          valueType: "enum_list",
          multiplicity: "many",
          unit: null,
          requirementRules: [{ layer: "code_ordering", level: "mandatory", when: null }],
          presetMode: "suggested",
          presets: [{ value: "cow", label: "Корова" }],
        },
        {
          id: "vetDocumentNumber",
          label: "Номер ВСД",
          valueType: "string",
          multiplicity: "one",
          unit: null,
          requirementRules: [
            {
              layer: "circulation",
              level: "mandatory",
              when: { attributeId: "animalSpecies", operator: "includes", value: "cow" },
            },
          ],
          presetMode: "none",
          presets: [],
        },
      ],
    });
  });

  it("rejects a widened legacy definition", () => {
    expect(() =>
      parseCategorySchemaDefinition({
        categoryId: "legacy",
        scopeKey: "category:legacy|tnved:none",
        attributes: [],
        privateProviderField: "must-not-pass",
      }),
    ).toThrow();
  });
});

describe("validateProductAttributeValue", () => {
  const volume: CategoryAttributeDefinition = {
    id: "volume",
    label: "Объём",
    valueType: "decimal",
    multiplicity: "one",
    unit: { canonical: "l", allowed: ["l", "ml"] },
    requirementRules: [],
    presetMode: "none",
    presets: [],
  };

  it("accepts a decimal value only in a reviewed unit", () => {
    expect(
      validateProductAttributeValue(volume, { type: "decimal", value: "1.5", unit: "l" }),
    ).toBe(true);
    expect(
      validateProductAttributeValue(volume, { type: "decimal", value: "1.5", unit: "kg" }),
    ).toBe(false);
  });

  it("rejects a value whose discriminator differs from the attribute type", () => {
    expect(validateProductAttributeValue(volume, { type: "string", value: "1.5" })).toBe(false);
  });

  it("treats suggested presets as guidance and restricted presets as validation", () => {
    const suggested: CategoryAttributeDefinition = {
      id: "comment",
      label: "Комментарий",
      valueType: "string",
      multiplicity: "one",
      unit: null,
      requirementRules: [],
      presetMode: "suggested",
      presets: [{ value: "one", label: "Один" }],
    };
    const restricted: CategoryAttributeDefinition = {
      ...suggested,
      id: "kind",
      label: "Вид",
      valueType: "enum",
      presetMode: "restricted",
    };

    expect(validateProductAttributeValue(suggested, { type: "string", value: "custom" })).toBe(
      true,
    );
    expect(validateProductAttributeValue(restricted, { type: "enum", value: "custom" })).toBe(
      false,
    );
  });
});

describe("isAttributeRequired", () => {
  it("applies a conditional mandatory rule only to its declared layer", () => {
    const values = { hasSweetener: { type: "boolean" as const, value: true } };

    expect(isAttributeRequired(sweetenerNameDefinition, values, "circulation")).toBe(true);
    expect(isAttributeRequired(sweetenerNameDefinition, values, "code_ordering")).toBe(false);
  });
});

describe("evaluateProductReadiness", () => {
  it("keeps code ordering ready while an activated circulation field is missing", () => {
    const result = evaluateProductReadiness({
      schemaVersionId: "schema-1",
      schema: schema([hasSweetenerDefinition, sweetenerNameDefinition]),
      values: { hasSweetener: { type: "boolean", value: true } },
      production: { chzProductGroupCode: 23, boxCapacity: 12, palletCapacity: 60 },
      egais: { applicable: false, codes: [], primaryCode: null },
      schemaStale: false,
    });

    expect(result.find((one) => one.dimension === "production")).toEqual({
      dimension: "production",
      state: "ready",
      reasons: [],
      recommendations: [],
    });
    expect(result.find((one) => one.dimension === "code_ordering")).toEqual({
      dimension: "code_ordering",
      state: "ready",
      reasons: [],
      recommendations: [],
    });
    expect(result.find((one) => one.dimension === "circulation")).toEqual({
      dimension: "circulation",
      state: "not_ready",
      reasons: [
        {
          code: "ATTRIBUTE_REQUIRED",
          attributeId: "sweetenerName",
          triggerAttributeId: "hasSweetener",
          schemaVersionId: "schema-1",
        },
      ],
      recommendations: [],
    });
    expect(result.find((one) => one.dimension === "egais")).toEqual({
      dimension: "egais",
      state: "not_applicable",
      reasons: [],
      recommendations: [],
    });
  });

  it("reports active recommended fields without making the layer not ready", () => {
    const recommended: CategoryAttributeDefinition = {
      id: "marketingName",
      label: "Маркетинговое название",
      valueType: "string",
      multiplicity: "one",
      unit: null,
      requirementRules: [{ layer: "code_ordering", level: "recommended", when: null }],
      presetMode: "none",
      presets: [],
    };

    const result = evaluateProductReadiness({
      schemaVersionId: "schema-recommended",
      schema: schema([recommended]),
      values: {},
      production: { chzProductGroupCode: 23, boxCapacity: 12, palletCapacity: 60 },
      egais: { applicable: false, codes: [], primaryCode: null },
      schemaStale: false,
    });

    expect(result.find((one) => one.dimension === "code_ordering")).toEqual({
      dimension: "code_ordering",
      state: "ready",
      reasons: [],
      recommendations: [
        {
          code: "ATTRIBUTE_RECOMMENDED",
          attributeId: "marketingName",
          schemaVersionId: "schema-recommended",
        },
      ],
    });
  });

  it("reports malformed beer AP codes and requires a primary code for multiples", () => {
    const result = evaluateProductReadiness({
      schemaVersionId: "schema-beer-1",
      schema: { ...schema([]), categoryId: "beer", scopeKey: "category:beer|tnved:none" },
      values: {},
      production: { chzProductGroupCode: 3, boxCapacity: 20, palletCapacity: 80 },
      egais: {
        applicable: true,
        codes: ["123456789012345678", "1234567890123456789"],
        primaryCode: null,
      },
      schemaStale: false,
    });

    expect(result.find((one) => one.dimension === "egais")).toEqual({
      dimension: "egais",
      state: "not_ready",
      reasons: [
        { code: "EGAIS_CODE_INVALID", attributeId: "egaisCodes" },
        { code: "EGAIS_PRIMARY_REQUIRED" },
      ],
      recommendations: [],
    });
  });

  it("keeps production reasons independent and marks regulatory data stale", () => {
    const result = evaluateProductReadiness({
      schemaVersionId: "schema-water-2",
      schema: schema([
        {
          id: "waterSourceType",
          label: "Тип источника воды",
          valueType: "enum",
          multiplicity: "one",
          unit: null,
          requirementRules: [{ layer: "code_ordering", level: "mandatory", when: null }],
          presetMode: "none",
          presets: [],
        },
      ]),
      values: {},
      production: { chzProductGroupCode: null, boxCapacity: null, palletCapacity: null },
      egais: { applicable: false, codes: [], primaryCode: null },
      schemaStale: true,
    });

    expect(result.find((one) => one.dimension === "production")).toEqual({
      dimension: "production",
      state: "not_ready",
      reasons: [
        { code: "PRODUCTION_GROUP_REQUIRED" },
        { code: "PRODUCTION_BOX_CAPACITY_REQUIRED" },
        { code: "PRODUCTION_PALLET_CAPACITY_REQUIRED" },
      ],
      recommendations: [],
    });
    expect(result.find((one) => one.dimension === "code_ordering")).toEqual({
      dimension: "code_ordering",
      state: "stale",
      reasons: [{ code: "SCHEMA_VERSION_STALE", schemaVersionId: "schema-water-2" }],
      recommendations: [],
    });
    expect(result.find((one) => one.dimension === "circulation")?.state).toBe("stale");
  });
});
