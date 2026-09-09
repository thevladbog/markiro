import { describe, expect, it } from "vitest";
import { chooseDefaultPhoto } from "../src/modules/national-catalog/national-catalog-photo-selection";

describe("National Catalog default photo", () => {
  const gtin = "04006381333931";
  it("does not select a primary photo belonging to a different GTIN", () => {
    expect(
      chooseDefaultPhoto(gtin, [
        { candidateId: "other", barcode: "04601234567893", primary: true },
      ]),
    ).toBeNull();
  });
  it("prefers a matching GTIN over an unbarcoded primary", () => {
    expect(
      chooseDefaultPhoto(gtin, [
        { candidateId: "good", barcode: null, primary: true },
        { candidateId: "matching", barcode: gtin, primary: false },
      ]),
    ).toBe("matching");
  });
  it("requires an unambiguous primary or sole eligible image", () => {
    expect(
      chooseDefaultPhoto(gtin, [
        { candidateId: "a", barcode: null, primary: true },
        { candidateId: "b", barcode: null, primary: true },
      ]),
    ).toBeNull();
    expect(chooseDefaultPhoto(gtin, [{ candidateId: "a", barcode: null, primary: false }])).toBe(
      "a",
    );
    expect(
      chooseDefaultPhoto(gtin, [
        { candidateId: "a", barcode: gtin, primary: false },
        { candidateId: "b", barcode: gtin, primary: true },
      ]),
    ).toBe("b");
  });
});
