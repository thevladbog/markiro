import type { CategorySchemaDefinition } from "@markiro/domain";
import type { ProductDto } from "../src/pages/catalog/api.js";

export const PRODUCT_ID = "00000000-0000-4000-8000-000000000023";
export const SCHEMA_ID = "00000000-0000-4000-8000-000000000033";
export const PROPOSAL_ID = "00000000-0000-4000-8000-000000000035";
export const AT = "2026-09-11T10:00:00.000Z";
// Synthetic examples exercise the generic editor. They are not official category schemas.
export function product(group = 23): ProductDto {
  return {
    id: PRODUCT_ID,
    gtin14: "04600682000013",
    name: group === 23 ? "Сок яблочный" : group === 33 ? "Масло подсолнечное" : "Крем для рук",
    printName: null,
    productGroup: "Тестовая группа",
    chzProductGroupCode: group,
    boxCapacity: 12,
    palletCapacity: 48,
    unitPrice: null,
    egaisCode: null,
    shelfLifeDays: 180,
    externalRef: null,
    status: "active",
    archived: false,
    defaultCounterpartyId: null,
    createdAt: AT,
  };
}
export function definition(group = 23): CategorySchemaDefinition {
  return {
    formatVersion: 2,
    categoryId: String(group),
    scopeKey: `test:${group}`,
    attributes: [
      {
        id: "quantity",
        label: group === 33 ? "Масса нетто" : "Объём",
        valueType: "decimal",
        multiplicity: "one",
        unit:
          group === 33
            ? { canonical: "г", allowed: ["г", "кг"] }
            : { canonical: "мл", allowed: ["мл", "л"] },
        requirementRules: [{ layer: "code_ordering", level: "mandatory", when: null }],
        presetMode: "none",
        presets: [],
      },
      {
        id: "sweet",
        label: "Содержит подсластитель",
        valueType: "boolean",
        multiplicity: "one",
        unit: null,
        requirementRules: [],
        presetMode: "none",
        presets: [],
      },
      {
        id: "sweetNames",
        label: "Наименования подсластителей",
        valueType: "string_list",
        multiplicity: "many",
        unit: null,
        requirementRules: [
          {
            layer: "circulation",
            level: "mandatory",
            when: { attributeId: "sweet", operator: "equals", value: true },
          },
        ],
        presetMode: "none",
        presets: [],
      },
    ],
  };
}
export function profile(group = 23) {
  return {
    productId: PRODUCT_ID,
    binding: {
      tenantId: "test",
      productId: PRODUCT_ID,
      revision: 4,
      categoryId: String(group),
      categoryName: product(group).name,
      tnVedCode: "2009719909",
      okpd2Code: null,
      schemaVersionId: SCHEMA_ID,
      source: "national_catalog",
      confirmedBy: null,
      confirmedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    },
    definition: definition(group),
    values: [
      {
        entryId: "00000000-0000-4000-8000-000000000041",
        attributeId: "quantity",
        value: { type: "decimal", value: "500", unit: group === 33 ? "г" : "мл" },
        source: "national_catalog",
        observedAt: AT,
        appliedAt: AT,
      },
      {
        entryId: "00000000-0000-4000-8000-000000000042",
        attributeId: "sweet",
        value: { type: "boolean", value: false },
        source: "manual",
        observedAt: null,
        appliedAt: AT,
      },
      {
        entryId: "00000000-0000-4000-8000-000000000043",
        attributeId: "sweetNames",
        value: { type: "string_list", value: ["Стевия"] },
        source: "national_catalog",
        observedAt: AT,
        appliedAt: AT,
      },
    ],
    egaisCodes: [],
    pendingProposalCount: 0,
  };
}
export const readiness = {
  productId: PRODUCT_ID,
  dimensions: [
    { dimension: "production", state: "ready", reasons: [], recommendations: [] },
    {
      dimension: "code_ordering",
      state: "not_ready",
      reasons: [
        { code: "ATTRIBUTE_REQUIRED", attributeId: "quantity", schemaVersionId: SCHEMA_ID },
      ],
      recommendations: [],
    },
    {
      dimension: "circulation",
      state: "not_ready",
      reasons: [{ code: "CATEGORY_NOT_CONFIRMED" }],
      recommendations: [],
    },
    { dimension: "egais", state: "not_applicable", reasons: [], recommendations: [] },
  ],
};
