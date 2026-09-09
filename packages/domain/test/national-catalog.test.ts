import { describe, expect, it } from "vitest";

import { parseImportGtins } from "../src/catalog/national-catalog.js";

describe("parseImportGtins", () => {
  it("keeps valid normalized GTINs while reporting invalid entries", () => {
    expect(parseImportGtins("4006381333931; 04006381333931\n4006381333930, abc")).toEqual({
      gtins: ["04006381333931"],
      invalid: ["4006381333930", "abc"],
    });
  });

  it("accepts and normalizes GTIN-8, GTIN-12, GTIN-13, and GTIN-14", () => {
    expect(parseImportGtins("46006820 036000291452 4006381333931 04600682000013")).toEqual({
      gtins: ["00000046006820", "00036000291452", "04006381333931", "04600682000013"],
      invalid: [],
    });
  });

  it("returns empty lists for empty input", () => {
    expect(parseImportGtins(" \n, ;\t")).toEqual({ gtins: [], invalid: [] });
  });

  it("deduplicates invalid entries while preserving encounter order", () => {
    expect(parseImportGtins("bad, 12345; bad 67890")).toEqual({
      gtins: [],
      invalid: ["bad", "12345", "67890"],
    });
  });
});
