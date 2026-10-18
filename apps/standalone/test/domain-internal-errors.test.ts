import { describe, expect, it, vi } from "vitest";

import { analyzeImport } from "../src/office/templates/import-analysis.js";
import { BLANK_SPEC, duplicateLayoutInvalid } from "../src/office/templates/editor-model.js";

// The domain's parsers throw their own `DomainError` for bad input, which the
// editor words for the user. Anything else is a bug (here a `TypeError`) and
// must reach the console instead of passing for «invalid code» or «invalid
// layout»: these tests make the domain fail the way it never should.
vi.mock("@markiro/domain", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertDuplicateTemplate: vi.fn(() => {
    throw new TypeError("assertDuplicateTemplate is broken");
  }),
  parseLabelCode: vi.fn(() => {
    throw new TypeError("parseLabelCode is broken");
  }),
}));

describe("an error of the domain that is not a DomainError", () => {
  it("is not taken for an invalid duplicate layout", () => {
    expect(() => duplicateLayoutInvalid(BLANK_SPEC, "product_duplicate")).toThrow(TypeError);
  });

  it("is not taken for a duplicate rule that does not apply to another purpose", () => {
    expect(duplicateLayoutInvalid(BLANK_SPEC, "box")).toBe(false);
    expect(duplicateLayoutInvalid(BLANK_SPEC, "pallet")).toBe(false);
  });

  it("is not taken for invalid code when ZPL or TSPL is checked", () => {
    for (const format of ["zpl", "tspl"] as const) {
      expect(
        () => analyzeImport({ source: "^XA^XZ", format, dpi: 203, purpose: "box" }),
        format,
      ).toThrow(TypeError);
    }
  });
});
