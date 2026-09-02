import { describe, expect, it } from "vitest";

import { EGAIS_PRODUCT_GROUP_CODE, isEgaisApplicable } from "../src/index.js";

describe("EGAIS applicability", () => {
  it("applies only to the beer product group (ЧЗ code 15)", () => {
    expect(EGAIS_PRODUCT_GROUP_CODE).toBe(15);
    expect(isEgaisApplicable(15)).toBe(true);
    expect(isEgaisApplicable(8)).toBe(false);
    expect(isEgaisApplicable(null)).toBe(false);
    expect(isEgaisApplicable(undefined)).toBe(false);
  });
});
