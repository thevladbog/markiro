import { describe, expect, it } from "vitest";

import { summarizeNationalCatalogMatrix } from "../src/cli/report-national-catalog-matrix";

describe("summarizeNationalCatalogMatrix", () => {
  it("does not confuse several reviewed categories with unresolved candidates", () => {
    const mappings = ["10", "20"].map((categoryId) => ({
      chzProductGroupCode: 7,
      state: "exact" as const,
      categoryId,
      schemaVersionId: `00000000-0000-4000-8000-${categoryId.padStart(12, "0")}`,
    }));
    const groups = [{ code: 7, name: "Пиво и слабоалкогольные напитки" }];
    expect(summarizeNationalCatalogMatrix(groups, mappings)).toMatchObject({
      exact: 1,
      ambiguous: 0,
    });
    expect(
      summarizeNationalCatalogMatrix(groups, [
        ...mappings,
        {
          chzProductGroupCode: 7,
          state: "ambiguous",
          categoryId: "30",
          schemaVersionId: "new",
        },
      ]),
    ).toMatchObject({ exact: 0, ambiguous: 1 });
  });

  it("reports every classifier group as exact, ambiguous, or unmapped deterministically", () => {
    expect(
      summarizeNationalCatalogMatrix(
        [
          { code: 3, name: "Вода" },
          { code: 1, name: "Пиво" },
          { code: 2, name: "Молоко" },
        ],
        [
          {
            chzProductGroupCode: 1,
            state: "exact",
            categoryId: "10",
            schemaVersionId: "00000000-0000-4000-8000-000000000010",
          },
          {
            chzProductGroupCode: 2,
            state: "ambiguous",
            categoryId: "20",
            schemaVersionId: "00000000-0000-4000-8000-000000000020",
          },
          {
            chzProductGroupCode: 2,
            state: "ambiguous",
            categoryId: "21",
            schemaVersionId: "00000000-0000-4000-8000-000000000021",
          },
        ],
      ),
    ).toEqual({
      total: 3,
      exact: 1,
      ambiguous: 1,
      unmapped: 1,
      items: [
        {
          code: 1,
          name: "Пиво",
          state: "exact",
          categoryIds: ["10"],
          schemaVersionIds: ["00000000-0000-4000-8000-000000000010"],
        },
        {
          code: 2,
          name: "Молоко",
          state: "ambiguous",
          categoryIds: ["20", "21"],
          schemaVersionIds: [
            "00000000-0000-4000-8000-000000000020",
            "00000000-0000-4000-8000-000000000021",
          ],
        },
        {
          code: 3,
          name: "Вода",
          state: "unmapped",
          categoryIds: [],
          schemaVersionIds: [],
        },
      ],
    });
  });
});
