import { describe, expect, it } from "vitest";
import { headerShiftLabel } from "../src/lib/shift-label.js";

describe("headerShiftLabel", () => {
  it("names the shift by its number while the band names the product", () => {
    expect(headerShiftLabel({ number: "SEP26-021", productName: "Сидр" }, "s1")).toBe("SEP26-021");
  });

  it("falls back to the product, then the id, and stays empty outside a shift", () => {
    expect(headerShiftLabel({ number: null, productName: "Сидр" }, "s1")).toBe("Сидр");
    expect(headerShiftLabel(null, "s1")).toBe("s1");
    expect(headerShiftLabel(null, null)).toBeNull();
  });
});
