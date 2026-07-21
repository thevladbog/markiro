import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors.js";
import { gtinMatchesPrefix, isValidGtin, normalizeToGtin14 } from "../src/gs1/gtin.js";

describe("normalizeToGtin14", () => {
  it("pads EAN-13 to GTIN-14", () => {
    expect(normalizeToGtin14("4006381333931")).toBe("04006381333931");
  });
  it("keeps a valid GTIN-14 as is", () => {
    expect(normalizeToGtin14("04600682000013")).toBe("04600682000013");
  });
  it("pads GTIN-8", () => {
    // body "4600682" → GS1 mod-10 check digit 0
    expect(normalizeToGtin14("46006820")).toBe("00000046006820");
  });
  it("rejects wrong length", () => {
    expect(() => normalizeToGtin14("12345")).toThrow(DomainError);
  });
  it("rejects bad check digit with code GTIN_INVALID", () => {
    try {
      normalizeToGtin14("4006381333930");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe("GTIN_INVALID");
    }
  });
});

describe("isValidGtin", () => {
  it("true for valid EAN-13", () => {
    expect(isValidGtin("4006381333931")).toBe(true);
  });
  it("false for garbage", () => {
    expect(isValidGtin("hello")).toBe(false);
  });
});

describe("gtinMatchesPrefix", () => {
  it("matches when body starts with the company prefix", () => {
    expect(gtinMatchesPrefix("04600682000013", "4600682")).toBe(true);
  });
  it("does not match a foreign prefix", () => {
    expect(gtinMatchesPrefix("04006381333931", "4600682")).toBe(false);
  });
});
