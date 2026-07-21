import { describe, expect, it } from "vitest";
import { gs1CheckDigit, hasValidCheckDigit } from "../src/gs1/check-digit.js";

describe("gs1CheckDigit", () => {
  // GS1 General Specifications mod-10: weight 3 on the rightmost body digit,
  // alternating 3/1 leftwards.
  it("computes the GTIN-13 example check digit", () => {
    expect(gs1CheckDigit("629104150021")).toBe(3);
  });
  it("computes the EAN-13 retail example", () => {
    expect(gs1CheckDigit("400638133393")).toBe(1);
  });
  it("computes an SSCC-18 check digit (17-digit body)", () => {
    expect(gs1CheckDigit("34600682000000001")).toBe(4);
  });
  it("rejects non-digits", () => {
    expect(() => gs1CheckDigit("62910415002X")).toThrow(RangeError);
  });
  it("rejects empty input", () => {
    expect(() => gs1CheckDigit("")).toThrow(RangeError);
  });
});

describe("hasValidCheckDigit", () => {
  it("accepts valid full codes", () => {
    expect(hasValidCheckDigit("6291041500213")).toBe(true);
    expect(hasValidCheckDigit("4006381333931")).toBe(true);
  });
  it("rejects a tampered digit", () => {
    expect(hasValidCheckDigit("6291041500214")).toBe(false);
  });
  it("rejects non-numeric codes", () => {
    expect(hasValidCheckDigit("ABC")).toBe(false);
  });
});
