import { describe, expect, it } from "vitest";
import { clampPage, pageCount, pageItems, pageSizeFor } from "../src/session/pagination.js";

describe("fixed viewport pagination", () => {
  it.each([
    [480, 800, 5],
    [800, 480, 3],
  ])("uses %i×%i supported page size", (width, height, expected) => {
    expect(pageSizeFor(width, height)).toBe(expected);
  });

  it("bounds pages after removal or rotation without losing source lines", () => {
    const lines = ["a", "b", "c", "d", "e", "f"];
    expect(pageCount(lines.length, 5)).toBe(2);
    expect(pageItems(lines, 1, 5)).toEqual(["f"]);
    expect(clampPage(9, lines.length, 5)).toBe(1);
    expect(clampPage(1, 2, 5)).toBe(0);
    expect(lines).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("fails closed to non-empty bounded slices for corrupt dimensions and pages", () => {
    expect(pageSizeFor(Number.NaN, 800)).toBe(5);
    expect(pageItems([1, 2, 3], -9, 0)).toEqual([1]);
  });
});
