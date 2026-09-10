import { describe, expect, it } from "vitest";

import { legalTableColumnLayout, legalTableColumnPercents } from "./legal-table.js";

describe("legalTableColumnPercents", () => {
  it("splits equal columns when no ratios are given", () => {
    expect(legalTableColumnPercents(4, undefined)).toEqual([25, 25, 25, 25]);
  });

  it("keeps a thirds split summing to a full row", () => {
    const percents = legalTableColumnPercents(3, undefined);
    expect(percents).toEqual([33.33, 33.33, 33.34]);
    expect(percents.reduce((sum, percent) => sum + percent, 0)).toBe(100);
  });

  it("maps ratios to proportional widths", () => {
    expect(legalTableColumnPercents(3, [1, 3, 1])).toEqual([20, 60, 20]);
  });

  it("normalizes ratios that do not add up to one", () => {
    expect(legalTableColumnPercents(2, [30, 70])).toEqual([30, 70]);
    expect(legalTableColumnPercents(2, [3, 7])).toEqual([30, 70]);
  });

  it("always spans the full row despite rounding", () => {
    for (const columnCount of [1, 2, 3, 6, 7, 9]) {
      const percents = legalTableColumnPercents(columnCount, undefined);
      expect(percents).toHaveLength(columnCount);
      expect(percents.reduce((sum, percent) => sum + percent, 0)).toBeCloseTo(100, 10);
    }
  });

  it("rejects a ratio list that does not match the column count", () => {
    expect(() => legalTableColumnPercents(3, [1, 2])).toThrow(/match the column count/);
  });

  it("rejects non-positive and non-finite ratios", () => {
    expect(() => legalTableColumnPercents(2, [1, 0])).toThrow(/positive numbers/);
    expect(() => legalTableColumnPercents(2, [1, -1])).toThrow(/positive numbers/);
    expect(() => legalTableColumnPercents(2, [1, Number.NaN])).toThrow(/positive numbers/);
  });

  it("rejects a table without columns", () => {
    expect(() => legalTableColumnPercents(0, undefined)).toThrow(/at least one column/);
  });
});

describe("legalTableColumnLayout", () => {
  it("returns the column widths for a well-formed table", () => {
    expect(
      legalTableColumnLayout({
        kind: "table",
        columns: ["Параметр", "Значение"],
        rows: [
          ["Срок", "12 месяцев"],
          ["Валюта", "RUB"],
        ],
        columnRatios: [1, 2],
      }),
    ).toEqual([33.33, 66.67]);
  });

  it("rejects a row that does not match its column count", () => {
    expect(() =>
      legalTableColumnLayout({
        kind: "table",
        columns: ["Параметр", "Значение"],
        rows: [["Срок"]],
      }),
    ).toThrow(/does not match its column count/);
  });
});
