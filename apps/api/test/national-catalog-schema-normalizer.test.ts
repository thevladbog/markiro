import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { normalizeNationalCatalogSchema } from "../src/modules/national-catalog/national-catalog-schema-normalizer";
import type { NationalCatalogAttributeDefinition } from "../src/modules/national-catalog/national-catalog.types";

function attribute(
  overrides: Partial<NationalCatalogAttributeDefinition> = {},
): NationalCatalogAttributeDefinition {
  return {
    id: 20,
    groupId: 2,
    groupName: "Основные",
    name: "Вид упаковки",
    presetOnly: true,
    multiplicity: false,
    multiplicityType: null,
    fieldType: "text",
    valueTypes: [],
    dependentAttributes: [],
    firstLayer: true,
    secondLayer: true,
    type: "m",
    preset: ["КЕГ", "БУТЫЛКА"],
    presetUrl: null,
    raw: { attr_id: 20 },
    ...overrides,
  };
}

describe("normalizeNationalCatalogSchema", () => {
  it("creates a deterministic strict format-v2 definition and hash", () => {
    const result = normalizeNationalCatalogSchema(
      { id: 30064, name: "Пиво", parentId: null, level: 1, active: true, gismtCodes: [7], raw: {} },
      [
        attribute({ id: 30, name: "Дата", fieldType: "date", presetOnly: false, preset: [] }),
        attribute(),
      ],
    );

    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.definition).toEqual({
      formatVersion: 2,
      categoryId: "30064",
      scopeKey: "national-catalog:category:30064",
      attributes: [
        {
          id: "20",
          label: "Вид упаковки",
          valueType: "enum",
          multiplicity: "one",
          unit: null,
          requirementRules: [
            { layer: "code_ordering", level: "mandatory", when: null },
            { layer: "circulation", level: "mandatory", when: null },
          ],
          presetMode: "restricted",
          presets: [
            { value: "БУТЫЛКА", label: "БУТЫЛКА" },
            { value: "КЕГ", label: "КЕГ" },
          ],
        },
        {
          id: "30",
          label: "Дата",
          valueType: "date",
          multiplicity: "one",
          unit: null,
          requirementRules: [
            { layer: "code_ordering", level: "mandatory", when: null },
            { layer: "circulation", level: "mandatory", when: null },
          ],
          presetMode: "none",
          presets: [],
        },
      ],
    });
    expect(result.contentHash).toBe(
      createHash("sha256").update(JSON.stringify(result.definition)).digest("hex"),
    );

    const reordered = normalizeNationalCatalogSchema(
      { id: 30064, name: "Пиво", parentId: null, level: 1, active: true, gismtCodes: [7], raw: {} },
      [
        attribute(),
        attribute({ id: 30, name: "Дата", fieldType: "date", presetOnly: false, preset: [] }),
      ],
    );
    expect(reordered).toEqual(result);
  });

  it.each([
    [
      "unique multiplicity",
      attribute({ multiplicity: true, multiplicityType: "unique" }),
      "unsupported_unique_multiplicity",
    ],
    [
      "dependencies",
      attribute({ dependentAttributes: [{ value: "КЕГ", attributes: [] }] }),
      "unsupported_dependency",
    ],
    ["unknown provider type", attribute({ type: "x" }), "unsupported_requirement_type"],
    ["unknown field type", attribute({ fieldType: null }), "unsupported_value_type"],
  ])("blocks %s instead of guessing", (_label, candidate, reason) => {
    const result = normalizeNationalCatalogSchema(
      { id: 1, name: "Категория", parentId: null, level: 1, active: true, gismtCodes: [], raw: {} },
      [candidate],
    );
    expect(result).toMatchObject({
      status: "blocked",
      reasons: [expect.objectContaining({ code: reason })],
    });
  });

  it("blocks duplicate attribute identities", () => {
    const result = normalizeNationalCatalogSchema(
      { id: 1, name: "Категория", parentId: null, level: 1, active: true, gismtCodes: [], raw: {} },
      [attribute(), attribute({ name: "Другое имя" })],
    );
    expect(result).toMatchObject({
      status: "blocked",
      reasons: [{ code: "duplicate_attribute_id", attributeId: "20" }],
    });
  });

  it("excludes provider-blocked contextual attributes and preserves reviewed numeric units", () => {
    const result = normalizeNationalCatalogSchema(
      { id: 1, name: "Категория", parentId: null, level: 1, active: true, gismtCodes: [], raw: {} },
      [
        attribute({ id: 19, type: "b" }),
        attribute({
          id: 20,
          name: "Объём",
          fieldType: "number",
          presetOnly: false,
          preset: [],
          valueTypes: ["мл", "л", "мл"],
        }),
      ],
    );

    expect(result).toMatchObject({
      status: "valid",
      definition: {
        attributes: [
          expect.objectContaining({
            id: "20",
            valueType: "decimal",
            unit: { canonical: "л", allowed: ["л", "мл"] },
          }),
        ],
      },
    });
  });

  it("normalizes a resolvable provider dependency into a conditional requirement", () => {
    const result = normalizeNationalCatalogSchema(
      { id: 1, name: "Категория", parentId: null, level: 1, active: true, gismtCodes: [], raw: {} },
      [
        attribute({
          id: 10,
          name: "Подлежит контролю",
          preset: ["ДА", "НЕТ"],
          dependentAttributes: [
            {
              value: "ДА",
              attributes: [{ id: 20, firstLayer: false, secondLayer: true, type: "m" }],
            },
          ],
        }),
        attribute({ id: 20, name: "Номер документа", presetOnly: false, preset: [], type: "o" }),
      ],
    );

    expect(result).toMatchObject({
      status: "valid",
      definition: {
        attributes: [
          expect.objectContaining({ id: "10" }),
          expect.objectContaining({
            id: "20",
            requirementRules: expect.arrayContaining([
              {
                layer: "circulation",
                level: "mandatory",
                when: { attributeId: "10", operator: "equals", value: "ДА" },
              },
            ]),
          }),
        ],
      },
    });
  });
});
