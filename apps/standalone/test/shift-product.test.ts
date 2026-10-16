import { describe, expect, it } from "vitest";
import { shiftProductTitle } from "../src/lib/shift-product";

describe("shiftProductTitle", () => {
  it("shows the print name when there is one", () => {
    expect(shiftProductTitle({ name: "Молоко питьевое 3,2 %", printName: "Молоко" })).toBe(
      "Молоко",
    );
  });

  it("trims the print name", () => {
    expect(shiftProductTitle({ name: "Молоко питьевое", printName: "  Молоко " })).toBe("Молоко");
  });

  it.each([null, undefined, "", "   ", "\t\n"])("falls back to the name for print name %j", (p) => {
    expect(shiftProductTitle({ name: "Молоко питьевое", printName: p })).toBe("Молоко питьевое");
  });

  it("takes the fallback name when the product is not known", () => {
    expect(shiftProductTitle(null, "Молоко питьевое")).toBe("Молоко питьевое");
    expect(shiftProductTitle(undefined, "Молоко питьевое")).toBe("Молоко питьевое");
  });

  it("falls back to the given name when the product has no name either", () => {
    expect(shiftProductTitle({ name: "", printName: " " }, "Запас")).toBe("Запас");
  });
});
