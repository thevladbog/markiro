import { describe, expect, it } from "vitest";

import {
  observeCatalogProjection,
  type CatalogProjection,
} from "../src/modules/national-catalog/national-catalog-observation-projection";

const schemaVersionId = "00000000-0000-4000-8000-000000000001";
const target = `attribute:${schemaVersionId}:21`;
const baseline: CatalogProjection = {
  version: 1,
  values: {
    name: "Напиток",
    [target]: { type: "decimal", value: "500", unit: "мл" },
  },
  context: {
    schemaVersionId,
    categoryId: "30064",
    groupCode: 23,
    definition: {
      formatVersion: 2,
      categoryId: "30064",
      scopeKey: "category:30064",
      attributes: [
        {
          id: "21",
          label: "Объём",
          valueType: "decimal",
          multiplicity: "one",
          unit: { canonical: "л", allowed: ["л", "мл"] },
          requirementRules: [],
          presetMode: "none",
          presets: [],
        },
      ],
    },
    stableMappings: [],
  },
};

function observe(attribute: Record<string, unknown>) {
  return observeCatalogProjection(
    {
      name: "Напиток",
      categories: [{ id: 30064 }],
      attributes: [{ id: 21, value: "500", gtin: null, ...attribute }],
    },
    "04601234567893",
    baseline,
    null,
  );
}

describe("National Catalog unit observations", () => {
  it("compares the exact current provider attr_value_type unit", () => {
    expect(observe({ valueType: "мл" }).values[target]).toEqual({
      type: "decimal",
      value: "500",
      unit: "мл",
    });
    expect(observe({ valueType: "л" }).values[target]).toEqual({
      type: "decimal",
      value: "500",
      unit: "л",
    });
  });

  it("reads legacy normalized unit snapshots and fails closed for absent or unknown units", () => {
    expect(observe({ unit: "мл" }).values[target]).toEqual({
      type: "decimal",
      value: "500",
      unit: "мл",
    });
    expect(observe({ valueType: null }).values).not.toHaveProperty(target);
    expect(observe({ valueType: "кг" }).values).not.toHaveProperty(target);
  });
});
