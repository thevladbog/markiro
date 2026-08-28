import { describe, expect, it } from "vitest";

import { chzProductGroups, products } from "../src/schema/platform.js";

describe("chz product groups schema", () => {
  it("exposes the columns the ChZ APIs need", () => {
    const columns = Object.keys(chzProductGroups);
    expect(columns).toEqual(expect.arrayContaining(["code", "alias", "name"]));
  });

  it("replaces the product's free-text group with a dictionary code", () => {
    const columns = Object.keys(products);
    expect(columns).toContain("chzProductGroupCode");
    // The free-text column is gone, not merely deprecated: leaving both would
    // let two sources of truth drift.
    expect(columns).not.toContain("productGroup");
  });
});
