import { describe, expect, it } from "vitest";

import {
  categorySchemaDefinitionSchema,
  evaluateProductReadiness,
  isAttributeRequired,
  type CategoryAttributeDefinition,
} from "../src/index.js";

const sweetenerNameDefinition: CategoryAttributeDefinition = {
  id: "sweetenerName",
  label: "Наименование подсластителя",
  valueType: "string_list",
  multiplicity: "many",
  requiredLayers: [],
  requiredWhen: [{ attributeId: "hasSweetener", operator: "equals", value: true }],
  presets: [],
};

const hasSweetenerDefinition: CategoryAttributeDefinition = {
  id: "hasSweetener",
  label: "Содержит подсластитель",
  valueType: "boolean",
  multiplicity: "one",
  requiredLayers: ["circulation"],
  requiredWhen: [],
  presets: [],
};

describe("categorySchemaDefinitionSchema", () => {
  it("accepts a strict schema whose conditions reference declared attributes", () => {
    const parsed = categorySchemaDefinitionSchema.parse({
      categoryId: "234225",
      scopeKey: "category:234225|tnved:none",
      attributes: [
        {
          id: "hasSweetener",
          label: "Содержит подсластитель",
          valueType: "boolean",
          multiplicity: "one",
          requiredLayers: ["circulation"],
          requiredWhen: [],
          presets: [],
        },
        {
          id: "sweetenerName",
          label: "Наименование подсластителя",
          valueType: "string_list",
          multiplicity: "many",
          requiredLayers: [],
          requiredWhen: [{ attributeId: "hasSweetener", operator: "equals", value: true }],
          presets: [],
        },
      ],
    });

    expect(parsed.categoryId).toBe("234225");
    expect(parsed.attributes.map((attribute) => attribute.id)).toEqual([
      "hasSweetener",
      "sweetenerName",
    ]);
  });

  it("rejects duplicate attributes and conditions that reference an unknown field", () => {
    const result = categorySchemaDefinitionSchema.safeParse({
      categoryId: "dairy",
      scopeKey: "category:dairy|tnved:none",
      attributes: [
        hasSweetenerDefinition,
        hasSweetenerDefinition,
        {
          ...sweetenerNameDefinition,
          requiredWhen: [{ attributeId: "missingTrigger", operator: "equals", value: true }],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        "Duplicate attribute id hasSweetener",
        "Unknown condition attribute missingTrigger",
      ]);
    }
  });
});

describe("isAttributeRequired", () => {
  it("activates a conditional field only when its trigger matches", () => {
    expect(
      isAttributeRequired(
        sweetenerNameDefinition,
        { hasSweetener: { type: "boolean", value: true } },
        "circulation",
      ),
    ).toBe(true);
    expect(
      isAttributeRequired(
        sweetenerNameDefinition,
        { hasSweetener: { type: "boolean", value: false } },
        "circulation",
      ),
    ).toBe(false);
  });

  it("activates a dairy condition when a multi-value trigger contains the preset", () => {
    const vetDocumentDefinition: CategoryAttributeDefinition = {
      id: "vetDocumentNumber",
      label: "Номер ВСД",
      valueType: "string",
      multiplicity: "one",
      requiredLayers: [],
      requiredWhen: [{ attributeId: "animalSpecies", operator: "includes", value: "cow" }],
      presets: [],
    };

    expect(
      isAttributeRequired(
        vetDocumentDefinition,
        { animalSpecies: { type: "enum_list", value: ["goat", "cow"] } },
        "circulation",
      ),
    ).toBe(true);
    expect(
      isAttributeRequired(
        vetDocumentDefinition,
        { animalSpecies: { type: "enum_list", value: ["goat"] } },
        "circulation",
      ),
    ).toBe(false);
  });
});

describe("evaluateProductReadiness", () => {
  it("keeps production ready while an activated circulation field is missing", () => {
    const result = evaluateProductReadiness({
      schemaVersionId: "schema-1",
      schema: {
        categoryId: "softdrinks",
        scopeKey: "category:softdrinks|tnved:none",
        attributes: [hasSweetenerDefinition, sweetenerNameDefinition],
      },
      values: { hasSweetener: { type: "boolean", value: true } },
      production: { chzProductGroupCode: 23, boxCapacity: 12, palletCapacity: 60 },
      egais: { applicable: false, codes: [], primaryCode: null },
      schemaStale: false,
    });

    expect(result.find((one) => one.dimension === "production")).toEqual({
      dimension: "production",
      state: "ready",
      reasons: [],
    });
    expect(result.find((one) => one.dimension === "code_ordering")?.state).toBe("ready");
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
    });
    expect(result.find((one) => one.dimension === "egais")?.state).toBe("not_applicable");
  });

  it("reports malformed beer AP codes and requires a primary code for multiples", () => {
    const result = evaluateProductReadiness({
      schemaVersionId: "schema-beer-1",
      schema: {
        categoryId: "beer",
        scopeKey: "category:beer|tnved:none",
        attributes: [],
      },
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
    });
  });

  it("keeps production reasons independent and marks regulatory water data stale", () => {
    const result = evaluateProductReadiness({
      schemaVersionId: "schema-water-2",
      schema: {
        categoryId: "water",
        scopeKey: "category:water|tnved:2201",
        attributes: [
          {
            id: "waterSourceType",
            label: "Тип источника воды",
            valueType: "enum",
            multiplicity: "one",
            requiredLayers: ["code_ordering"],
            requiredWhen: [],
            presets: [],
          },
        ],
      },
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
    });
    expect(result.find((one) => one.dimension === "code_ordering")).toEqual({
      dimension: "code_ordering",
      state: "stale",
      reasons: [{ code: "SCHEMA_VERSION_STALE", schemaVersionId: "schema-water-2" }],
    });
    expect(result.find((one) => one.dimension === "circulation")?.state).toBe("stale");
  });
});
