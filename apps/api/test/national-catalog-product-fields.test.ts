import { describe, expect, it } from "vitest";
import {
  catalogProductFieldForLabel,
  readCatalogProductFields,
} from "../src/modules/national-catalog/national-catalog-product-fields";
import {
  buildCatalogProjection,
  currentCatalogProjection,
  observeCatalogProjection,
  readCatalogProjection,
  reviewedCatalogValues,
  type CatalogProjection,
} from "../src/modules/national-catalog/national-catalog-observation-projection";
import { hasUnreviewedCatalogChanges } from "../src/modules/national-catalog/national-catalog-summary";
import { buildNationalCatalogImportEntries } from "../src/modules/national-catalog/national-catalog-proposal.service";

const GTIN14 = "04006381333931";
const EGAIS_CODE = "0300005753630000036";
// Synthetic fixture IDs, deliberately not a mapping to provider production IDs.
const SYNTHETIC_EGAIS_ID = 900001;
const SYNTHETIC_DAYS_ID = 900002;
type SourceAttribute = Parameters<typeof readCatalogProductFields>[0][number];

const egais: SourceAttribute = {
  id: SYNTHETIC_EGAIS_ID,
  name: "Код продукции в ЕГАИС",
  value: EGAIS_CODE,
  gtin: GTIN14,
};
const shelfLife: SourceAttribute = {
  id: SYNTHETIC_DAYS_ID,
  name: "Срок годности, дней",
  value: "365",
  gtin: null,
};

const PROVIDER_NAME = "Тестовый товар";
function productFieldBaseline() {
  return buildCatalogProjection({
    providerName: PROVIDER_NAME,
    mappedEntries: [],
    imageChecksum: null,
    context: null,
    productFields: readCatalogProductFields([egais, shelfLife], GTIN14),
  });
}

function source(attributes: SourceAttribute[]) {
  return { name: PROVIDER_NAME, categories: [], attributes };
}

describe("ordinary product fields from exact National Catalog labels", () => {
  it("preserves all 19 EGAIS digits and imports days without category data", () => {
    expect(readCatalogProductFields([egais, shelfLife], GTIN14)).toEqual([
      {
        targetField: "egais_code",
        sourceAttributeId: SYNTHETIC_EGAIS_ID,
        mappingVersion: 1,
        value: "0300005753630000036",
      },
      {
        targetField: "shelf_life_days",
        sourceAttributeId: SYNTHETIC_DAYS_ID,
        mappingVersion: 1,
        value: 365,
      },
    ]);
  });

  it("accepts surrounding whitespace without converting the EGAIS code to a number", () => {
    expect(
      readCatalogProductFields(
        [{ ...egais, name: "  Код продукции в ЕГАИС  ", value: ` ${EGAIS_CODE} ` }],
        GTIN14,
      ),
    ).toEqual([
      {
        targetField: "egais_code",
        sourceAttributeId: SYNTHETIC_EGAIS_ID,
        mappingVersion: 1,
        value: "0300005753630000036",
      },
    ]);
  });

  it.each([
    { raw: "1", days: 1 },
    { raw: "365", days: 365 },
    { raw: "3650", days: 3650 },
  ])("accepts shelf life of $days days", ({ raw, days }) => {
    expect(readCatalogProductFields([{ ...shelfLife, value: raw }], GTIN14)).toEqual([
      {
        targetField: "shelf_life_days",
        sourceAttributeId: SYNTHETIC_DAYS_ID,
        mappingVersion: 1,
        value: days,
      },
    ]);
  });

  it.each(["0", "3651", "-1", "+1", "1.5", "1,5", "1e2", "365 дней", "", "Infinity"])(
    "rejects non-integer, out-of-range or unit-bearing day value %j",
    (value) => {
      expect(readCatalogProductFields([{ ...shelfLife, value }], GTIN14)).toEqual([]);
    },
  );

  it.each([
    "030000575363000003",
    "03000057536300000360",
    "030000575363000003A",
    "0300005753 630000036",
    "3.00005753630000036e17",
    "",
  ])("rejects EGAIS values other than exactly 19 ASCII digits: %j", (value) => {
    expect(readCatalogProductFields([{ ...egais, value }], GTIN14)).toEqual([]);
  });

  it.each([
    "Код продукции в ЕГАИС (старый)",
    "Код алкогольной продукции",
    "Код продукции в EГАИС",
    "Срок годности, месяцев",
    "Срок годности, часов",
    "Срок годности",
  ])("does not infer a product field from the lookalike label %j", (name) => {
    expect(catalogProductFieldForLabel(name)).toBeUndefined();
    expect(readCatalogProductFields([{ ...egais, name }], GTIN14)).toEqual([]);
  });

  it("does not infer a label from an attribute ID when the label is absent", () => {
    expect(
      readCatalogProductFields(
        [{ id: SYNTHETIC_EGAIS_ID, value: EGAIS_CODE, gtin: GTIN14 }],
        GTIN14,
      ),
    ).toEqual([]);
  });

  it.each([egais, shelfLife])(
    "rejects two source IDs for $name even with the same value",
    (field) => {
      expect(readCatalogProductFields([field, { ...field, id: field.id + 100 }], GTIN14)).toEqual(
        [],
      );
    },
  );

  it.each([
    { field: egais, conflicting: "0300005753630000037" },
    { field: shelfLife, conflicting: "366" },
  ])("rejects different values for one source ID for $field.name", ({ field, conflicting }) => {
    expect(readCatalogProductFields([field, { ...field, value: conflicting }], GTIN14)).toEqual([]);
  });

  it("deduplicates repeated source IDs and values after trimming", () => {
    expect(
      readCatalogProductFields(
        [egais, { ...egais, value: ` ${EGAIS_CODE} ` }, shelfLife, { ...shelfLife }],
        GTIN14,
      ),
    ).toEqual([
      {
        targetField: "egais_code",
        sourceAttributeId: SYNTHETIC_EGAIS_ID,
        mappingVersion: 1,
        value: "0300005753630000036",
      },
      {
        targetField: "shelf_life_days",
        sourceAttributeId: SYNTHETIC_DAYS_ID,
        mappingVersion: 1,
        value: 365,
      },
    ]);
  });

  it("accepts matching GTIN-13 and unscoped values, ignoring foreign or invalid GTINs", () => {
    expect(
      readCatalogProductFields(
        [
          { ...egais, gtin: "4006381333931" },
          { ...egais, id: SYNTHETIC_EGAIS_ID + 100, gtin: "5901234123457" },
          { ...egais, id: SYNTHETIC_EGAIS_ID + 101, gtin: "4006381333932" },
          { ...egais, id: SYNTHETIC_EGAIS_ID + 102, gtin: "not-a-gtin" },
          shelfLife,
        ],
        GTIN14,
      ),
    ).toEqual([
      {
        targetField: "egais_code",
        sourceAttributeId: SYNTHETIC_EGAIS_ID,
        mappingVersion: 1,
        value: "0300005753630000036",
      },
      {
        targetField: "shelf_life_days",
        sourceAttributeId: SYNTHETIC_DAYS_ID,
        mappingVersion: 1,
        value: 365,
      },
    ]);
  });

  it.each(["5901234123457", "4006381333932", "not-a-gtin", ""])(
    "does not import only-foreign or invalid-GTIN attribute %j",
    (gtin) => {
      expect(
        readCatalogProductFields(
          [
            { ...egais, gtin },
            { ...shelfLife, gtin },
          ],
          GTIN14,
        ),
      ).toEqual([]);
    },
  );
});

describe("ordinary product fields in confirmed catalogue projections", () => {
  it("pins both reviewed fields and their source IDs without a regulatory profile", () => {
    expect(productFieldBaseline()).toEqual({
      version: 1,
      context: null,
      values: {
        name: "Тестовый товар",
        "stable:egais_code": "0300005753630000036",
        "stable:shelf_life_days": 365,
      },
      productFieldMappings: [
        { targetField: "egais_code", sourceAttributeId: SYNTHETIC_EGAIS_ID, mappingVersion: 1 },
        {
          targetField: "shelf_life_days",
          sourceAttributeId: SYNTHETIC_DAYS_ID,
          mappingVersion: 1,
        },
      ],
      supportedProductFields: ["egais_code", "shelf_life_days"],
    });
    expect(readCatalogProjection(productFieldBaseline())).toEqual(productFieldBaseline());
  });

  it("pins both supported fields when the confirmed source has neither value", () => {
    const baseline = buildCatalogProjection({
      providerName: PROVIDER_NAME,
      mappedEntries: [],
      imageChecksum: null,
      context: null,
      productFields: [],
    });

    expect(baseline).toEqual({
      version: 1,
      context: null,
      values: { name: PROVIDER_NAME },
      supportedProductFields: ["egais_code", "shelf_life_days"],
    });
    expect(reviewedCatalogValues(baseline)?.values).toEqual({
      name: PROVIDER_NAME,
      "stable:egais_code": null,
      "stable:shelf_life_days": null,
    });
    expect(
      currentCatalogProjection(
        baseline,
        {
          name: PROVIDER_NAME,
          printName: null,
          shelfLifeDays: null,
          egaisCode: null,
          chzProductGroupCode: null,
        },
        null,
        null,
      ).values,
    ).toEqual({
      name: PROVIDER_NAME,
      photo: null,
      "stable:egais_code": null,
      "stable:shelf_life_days": null,
    });
  });

  it("flags a supported field that first appears after an absent confirmation", () => {
    const baseline = buildCatalogProjection({
      providerName: PROVIDER_NAME,
      mappedEntries: [],
      imageChecksum: null,
      context: null,
      productFields: [],
    });
    const observed = observeCatalogProjection(source([egais]), GTIN14, baseline, null);
    const current = currentCatalogProjection(
      baseline,
      {
        name: PROVIDER_NAME,
        printName: null,
        shelfLifeDays: null,
        egaisCode: null,
        chzProductGroupCode: null,
      },
      null,
      null,
    );

    expect(observed.values).toEqual({
      name: PROVIDER_NAME,
      "stable:egais_code": EGAIS_CODE,
    });
    expect(
      hasUnreviewedCatalogChanges({
        reviewed: reviewedCatalogValues(baseline),
        observed,
        current,
      }),
    ).toBe(true);
  });

  it("observes new values only through the reviewed source IDs", () => {
    const baseline = productFieldBaseline();
    const observed = observeCatalogProjection(
      source([
        { ...egais, value: "0300005753630000037" },
        { ...shelfLife, value: "730" },
      ]),
      GTIN14,
      baseline,
      null,
    );
    expect(observed.values).toEqual({
      name: "Тестовый товар",
      "stable:egais_code": "0300005753630000037",
      "stable:shelf_life_days": 730,
    });
    expect(observed.productFieldMappings).toEqual(baseline.productFieldMappings);

    const changedSource = observeCatalogProjection(
      source([{ ...egais, id: SYNTHETIC_EGAIS_ID + 100, value: "0300005753630000037" }, shelfLife]),
      GTIN14,
      baseline,
      null,
    );
    expect(changedSource.values).toEqual({
      name: "Тестовый товар",
      "stable:egais_code": { state: "review_required", reason: "source_field_changed" },
      "stable:shelf_life_days": 365,
    });
    expect(changedSource.productFieldMappings).toEqual(baseline.productFieldMappings);
  });

  it("flags a changed label instead of accepting its pinned source ID", () => {
    const observed = observeCatalogProjection(
      source([{ ...egais, name: "Другой код", value: "0300005753630000037" }, shelfLife]),
      GTIN14,
      productFieldBaseline(),
      null,
    );
    expect(observed.values).toEqual({
      name: "Тестовый товар",
      "stable:egais_code": { state: "review_required", reason: "source_field_changed" },
      "stable:shelf_life_days": 365,
    });
  });

  it.each([
    {
      label: "ambiguous source IDs",
      attributes: [egais, { ...egais, id: SYNTHETIC_EGAIS_ID + 100 }],
    },
    {
      label: "invalid value",
      attributes: [{ ...egais, value: "invalid" }],
    },
  ])("flags $label on a pinned field without trusting a candidate value", ({ attributes }) => {
    const baseline = productFieldBaseline();
    const observed = observeCatalogProjection(source(attributes), GTIN14, baseline, null);
    const current = currentCatalogProjection(
      baseline,
      {
        name: PROVIDER_NAME,
        printName: null,
        shelfLifeDays: 365,
        egaisCode: EGAIS_CODE,
        chzProductGroupCode: null,
      },
      null,
      null,
    );

    expect(observed.values["stable:egais_code"]).toEqual({
      state: "review_required",
      reason: "source_field_changed",
    });
    expect(
      hasUnreviewedCatalogChanges({
        reviewed: reviewedCatalogValues(baseline),
        observed,
        current,
      }),
    ).toBe(true);
  });

  it("does not observe foreign or invalid GTIN values through pinned source IDs", () => {
    const observed = observeCatalogProjection(
      source([
        { ...egais, gtin: "5901234123457", value: "0300005753630000037" },
        { ...shelfLife, gtin: "4006381333932", value: "730" },
      ]),
      GTIN14,
      productFieldBaseline(),
      null,
    );
    expect(observed.values).toEqual({ name: "Тестовый товар" });
  });

  it("keeps a missing pinned provider attribute unknown instead of treating it as removal", () => {
    const baseline = productFieldBaseline();
    const observed = observeCatalogProjection(source([]), GTIN14, baseline, null);
    const current = currentCatalogProjection(
      baseline,
      {
        name: PROVIDER_NAME,
        printName: null,
        shelfLifeDays: 365,
        egaisCode: EGAIS_CODE,
        chzProductGroupCode: null,
      },
      null,
      null,
    );

    expect(observed.values).toEqual({ name: PROVIDER_NAME });
    expect(
      hasUnreviewedCatalogChanges({
        reviewed: reviewedCatalogValues(baseline),
        observed,
        current,
      }),
    ).toBe(false);
  });

  it("does not fall back to a category shelf-life mapping when the pinned built-in source changes", () => {
    const categoryAttributeId = SYNTHETIC_DAYS_ID + 100;
    const baseline = buildCatalogProjection({
      providerName: PROVIDER_NAME,
      mappedEntries: [],
      imageChecksum: null,
      context: {
        schemaVersionId: "00000000-0000-4000-8000-000000000010",
        categoryId: "10",
        groupCode: 23,
        definition: {
          formatVersion: 2,
          categoryId: "10",
          scopeKey: "projection-test",
          attributes: [],
        },
        stableMappings: [
          {
            id: "00000000-0000-4000-8000-000000000020",
            sourceAttributeId: String(categoryAttributeId),
            targetField: "shelf_life_days",
            conversion: { kind: "positive_integer" },
            mappingVersion: 1,
          },
        ],
      },
      productFields: readCatalogProductFields([shelfLife], GTIN14),
    });
    const observed = observeCatalogProjection(
      {
        ...source([{ ...shelfLife, id: categoryAttributeId, value: "730" }]),
        categories: [{ id: 10 }],
      },
      GTIN14,
      baseline,
      null,
    );

    expect(observed.values["stable:shelf_life_days"]).toEqual({
      state: "review_required",
      reason: "source_field_changed",
    });
  });

  it("excludes a category attribute whose target ID is the pinned built-in source ID", () => {
    const schemaVersionId = "00000000-0000-4000-8000-000000000030";
    const baseline = buildCatalogProjection({
      providerName: PROVIDER_NAME,
      mappedEntries: [],
      imageChecksum: null,
      context: {
        schemaVersionId,
        categoryId: "10",
        groupCode: 23,
        definition: {
          formatVersion: 2,
          categoryId: "10",
          scopeKey: "projection-attribute-test",
          attributes: [
            {
              id: String(SYNTHETIC_DAYS_ID),
              label: "Duplicate category shelf life",
              valueType: "decimal",
              multiplicity: "one",
              unit: null,
              requirementRules: [],
              presetMode: "none",
              presets: [],
            },
          ],
        },
        stableMappings: [],
      },
      productFields: readCatalogProductFields([shelfLife], GTIN14),
    });
    const observed = observeCatalogProjection(
      { ...source([shelfLife]), categories: [{ id: 10 }] },
      GTIN14,
      baseline,
      null,
    );

    expect(reviewedCatalogValues(baseline)?.values).not.toHaveProperty(
      `attribute:${schemaVersionId}:${SYNTHETIC_DAYS_ID}`,
    );
    expect(observed.values).not.toHaveProperty(`attribute:${schemaVersionId}:${SYNTHETIC_DAYS_ID}`);
    expect(observed.values["stable:shelf_life_days"]).toBe(365);
  });

  it("leaves legacy baselines without product mappings outside the new supported fields", () => {
    const legacy: CatalogProjection = {
      version: 1,
      context: null,
      values: { name: "Тестовый товар" },
    };
    expect(readCatalogProjection(legacy)).toEqual(legacy);
    const observed = observeCatalogProjection(source([egais, shelfLife]), GTIN14, legacy, null);
    expect(observed).toEqual(legacy);
    const current = currentCatalogProjection(
      legacy,
      {
        name: PROVIDER_NAME,
        printName: null,
        shelfLifeDays: null,
        egaisCode: null,
        chzProductGroupCode: null,
      },
      null,
      null,
    );
    expect(current.values).toEqual({ name: "Тестовый товар", photo: null });
    expect(
      hasUnreviewedCatalogChanges({ reviewed: reviewedCatalogValues(legacy), observed, current }),
    ).toBe(false);
  });

  it("preserves a legacy category attribute that happens to share a recognized source ID", () => {
    const schemaVersionId = "00000000-0000-4000-8000-000000000040";
    const legacy = buildCatalogProjection({
      providerName: PROVIDER_NAME,
      mappedEntries: [],
      imageChecksum: null,
      context: {
        schemaVersionId,
        categoryId: "10",
        groupCode: 23,
        definition: {
          formatVersion: 2,
          categoryId: "10",
          scopeKey: "legacy-projection-test",
          attributes: [
            {
              id: String(SYNTHETIC_DAYS_ID),
              label: "Legacy category value",
              valueType: "decimal",
              multiplicity: "one",
              unit: null,
              requirementRules: [],
              presetMode: "none",
              presets: [],
            },
          ],
        },
        stableMappings: [],
      },
    });
    const observed = observeCatalogProjection(
      { ...source([shelfLife]), categories: [{ id: 10 }] },
      GTIN14,
      legacy,
      null,
    );

    expect(observed.values).toHaveProperty(`attribute:${schemaVersionId}:${SYNTHETIC_DAYS_ID}`);
    expect(observed.values).not.toHaveProperty("stable:shelf_life_days");
  });

  it("retains a category-only shelf-life projection when no valid built-in field resolved", () => {
    const schemaVersionId = "00000000-0000-4000-8000-000000000050";
    const categoryShelfSourceId = 42;
    const context: NonNullable<CatalogProjection["context"]> = {
      schemaVersionId,
      categoryId: "10",
      groupCode: 23,
      definition: {
        formatVersion: 2,
        categoryId: "10",
        scopeKey: "category-shelf-projection-test",
        attributes: [],
      },
      stableMappings: [
        {
          id: "00000000-0000-4000-8000-000000000051",
          sourceAttributeId: String(categoryShelfSourceId),
          targetField: "shelf_life_days",
          conversion: { kind: "positive_integer" },
          mappingVersion: 1,
        },
      ],
    };
    const mappedEntries = buildNationalCatalogImportEntries({
      schemaVersionId,
      definitions: [],
      currentValues: new Map(),
      sourceAttributes: [{ id: categoryShelfSourceId, value: "365", unit: null }],
      sourceName: PROVIDER_NAME,
      stableMappings: context.stableMappings,
      currentStableFields: new Map([["shelf_life_days", null]]),
    }).entries;
    const baseline = buildCatalogProjection({
      providerName: PROVIDER_NAME,
      mappedEntries,
      imageChecksum: null,
      context,
      productFields: [],
    });

    expect(baseline.values["stable:shelf_life_days"]).toBe(365);
    const observed = observeCatalogProjection(
      {
        ...source([
          {
            id: categoryShelfSourceId,
            name: "Категорийный срок хранения",
            value: "730",
            gtin: null,
          },
        ]),
        categories: [{ id: 10 }],
      },
      GTIN14,
      baseline,
      null,
    );
    expect(observed.values["stable:shelf_life_days"]).toBe(730);
  });

  it("compares changes to ordinary local fields even when there is no category or profile", () => {
    const baseline = productFieldBaseline();
    const product = {
      name: PROVIDER_NAME,
      printName: null,
      shelfLifeDays: 365,
      egaisCode: EGAIS_CODE,
      chzProductGroupCode: null,
    };
    const current = currentCatalogProjection(baseline, product, null, null);
    expect(current.values).toEqual({
      name: "Тестовый товар",
      photo: null,
      "stable:egais_code": "0300005753630000036",
      "stable:shelf_life_days": 365,
    });
    const observed = observeCatalogProjection(
      source([
        { ...egais, value: "0300005753630000037" },
        { ...shelfLife, value: "730" },
      ]),
      GTIN14,
      baseline,
      null,
    );
    const reviewed = reviewedCatalogValues(baseline);
    expect(hasUnreviewedCatalogChanges({ reviewed, observed, current })).toBe(true);
    const updatedCurrent = currentCatalogProjection(
      baseline,
      { ...product, egaisCode: "0300005753630000037", shelfLifeDays: 730 },
      null,
      null,
    );
    expect(hasUnreviewedCatalogChanges({ reviewed, observed, current: updatedCurrent })).toBe(
      false,
    );
    expect(
      hasUnreviewedCatalogChanges({ reviewed, observed: baseline, current: updatedCurrent }),
    ).toBe(false);
  });
});
