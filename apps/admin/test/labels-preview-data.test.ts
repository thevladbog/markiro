import { describe, expect, it } from "vitest";

import { labelPreviewData, labelRenderOptions } from "../src/pages/labels/preview-data.js";

/**
 * Slice 06d review fix: `labelPreviewData`/`labelRenderOptions` used to be a
 * binary `purpose === "product_duplicate" ? duplicate : box` ternary, so a
 * pallet-purpose template's card thumbnail and editor preview silently
 * rendered box sample data -- the two purposes were indistinguishable in
 * the library. These pin the pallet branch to its own sample and confirm it
 * no longer collapses into the box branch.
 */
describe("labelPreviewData", () => {
  it("gives every purpose its own sample instead of collapsing into the box sample", () => {
    const box = labelPreviewData("box");
    const duplicate = labelPreviewData("product_duplicate");
    const pallet = labelPreviewData("pallet");

    expect(pallet).not.toEqual(box);
    expect(pallet).not.toEqual(duplicate);
  });

  it("gives a pallet its own sscc, distinct from any box's", () => {
    const box = labelPreviewData("box");
    const pallet = labelPreviewData("pallet");

    expect(pallet.sscc).not.toBe("");
    expect(pallet.sscc).not.toBe(box.sscc);
  });

  it("carries a non-empty qty.boxes on the pallet sample -- a box holds no boxes, a pallet does", () => {
    const pallet = labelPreviewData("pallet");

    expect(pallet["qty.boxes"]).not.toBe("");
  });

  it("defaults to the box sample when no purpose is given", () => {
    expect(labelPreviewData()).toEqual(labelPreviewData("box"));
  });
});

describe("labelRenderOptions", () => {
  it("only rasterizes the km.code barcode for product_duplicate, never for pallet or box", () => {
    expect(labelRenderOptions("box").kmDataMatrix).not.toBe("raster");
    expect(labelRenderOptions("pallet").kmDataMatrix).not.toBe("raster");
    expect(labelRenderOptions("product_duplicate").kmDataMatrix).toBe("raster");
  });
});
