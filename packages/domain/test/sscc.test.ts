import { describe, expect, it } from "vitest";
import { buildSscc, isValidSscc, ssccSerialCapacity } from "../src/gs1/sscc.js";

describe("buildSscc", () => {
  it("builds ext+prefix+padded serial+check", () => {
    // body 3 4600682 000000001 → check 4 (see check-digit tests)
    expect(buildSscc(3, "4600682", 1)).toBe("346006820000000014");
  });
  it("throws SSCC_RANGE when serial exceeds capacity", () => {
    expect(() => buildSscc(3, "4600682", 10 ** 9)).toThrowError(
      expect.objectContaining({ code: "SSCC_RANGE" }),
    );
  });
  it("throws SSCC_PREFIX on non-digit prefix", () => {
    expect(() => buildSscc(3, "46A0682", 1)).toThrowError(
      expect.objectContaining({ code: "SSCC_PREFIX" }),
    );
  });
  it("throws SSCC_PREFIX on a bad extension digit", () => {
    expect(() => buildSscc(10, "4600682", 1)).toThrowError(
      expect.objectContaining({ code: "SSCC_PREFIX" }),
    );
  });
});

describe("isValidSscc", () => {
  it("accepts a built SSCC", () => {
    expect(isValidSscc(buildSscc(3, "4600682", 42))).toBe(true);
  });
  it("rejects wrong length and bad check digit", () => {
    expect(isValidSscc("12345")).toBe(false);
    expect(isValidSscc("346006820000000015")).toBe(false);
  });
});

describe("ssccSerialCapacity", () => {
  it("is 10^(16 - prefix length)", () => {
    expect(ssccSerialCapacity("4600682")).toBe(10 ** 9);
    expect(ssccSerialCapacity("460068201")).toBe(10 ** 7);
  });
});
