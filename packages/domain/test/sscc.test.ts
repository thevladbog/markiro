import { describe, expect, it } from "vitest";
import {
  buildSscc,
  DomainError,
  formatSsccHri,
  formatSsccWithAi,
  isValidSscc,
  parseScannedSscc,
  parseSscc,
  ssccSerialCapacity,
} from "../src/index.js";

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
  it("accepts the last serial in capacity", () => {
    expect(buildSscc(3, "4600682", 10 ** 9 - 1)).toMatch(/^34600682999999999\d$/);
  });
  it("throws SSCC_RANGE on negative and non-integer serials", () => {
    expect(() => buildSscc(3, "4600682", -1)).toThrowError(
      expect.objectContaining({ code: "SSCC_RANGE" }),
    );
    expect(() => buildSscc(3, "4600682", 1.5)).toThrowError(
      expect.objectContaining({ code: "SSCC_RANGE" }),
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
  it("throws SSCC_PREFIX on invalid prefixes", () => {
    expect(() => ssccSerialCapacity("")).toThrowError(
      expect.objectContaining({ code: "SSCC_PREFIX" }),
    );
    expect(() => ssccSerialCapacity("46A0682")).toThrowError(
      expect.objectContaining({ code: "SSCC_PREFIX" }),
    );
    expect(() => ssccSerialCapacity("46006820000006820")).toThrowError(
      expect.objectContaining({ code: "SSCC_PREFIX" }),
    );
  });
});

describe("parseScannedSscc", () => {
  const sscc = "346006820000000014";

  it.each([
    [sscc, sscc],
    [`00${sscc}`, sscc],
    [`(00)${sscc}`, sscc],
    [`]C1${sscc}`, sscc],
    [`]C100${sscc}`, sscc],
    [`]C1(00)${sscc}`, sscc],
  ])("normalizes scanner SSCC %s", (raw, expected) => {
    expect(parseScannedSscc(raw)).toBe(expected);
  });

  it.each([
    `${sscc}0`,
    `(00)${sscc.slice(0, -1)}0`,
    `]C1\u001d00${sscc}`,
    `]C1(00)${sscc}0`,
    `prefix${sscc}`,
  ])("rejects malformed scanner SSCC %s", (raw) => {
    expect(parseScannedSscc(raw)).toBeNull();
  });

  it("rejects a payload with a bad check digit", () => {
    const broken = sscc.slice(0, 17) + (sscc[17] === "0" ? "1" : "0");
    expect(parseScannedSscc(broken)).toBeNull();
  });

  it("rejects a KM DataMatrix payload", () => {
    expect(parseScannedSscc("0104601234567890215Abc")).toBeNull();
  });

  it("rejects an empty payload", () => {
    expect(parseScannedSscc("")).toBeNull();
  });

  it("rejects a wrong application identifier", () => {
    // Payload with "01" (not "00") app ID + valid SSCC = 20 characters
    expect(parseScannedSscc(`01${sscc}`)).toBeNull();
  });

  it("accepts a bare SSCC that starts with 00", () => {
    const sscc = buildSscc(0, "012345678", 1);
    // Verify the fixture really starts with "00"
    expect(sscc.startsWith("00")).toBe(true);
    expect(parseScannedSscc(sscc)).toBe(sscc);
  });
});

describe("parseSscc", () => {
  it("is the exact inverse of buildSscc", () => {
    const sscc = buildSscc(3, "4600682", 1);
    expect(sscc).toBe("346006820000000014");
    expect(parseSscc(sscc, 7)).toEqual({
      extensionDigit: 3,
      gs1Prefix: "4600682",
      serial: 1,
    });
  });

  it("round-trips a 9-digit issuer prefix (this app's actual usage)", () => {
    const sscc = buildSscc(0, "460123456", 12_345);
    expect(parseSscc(sscc, 9)).toEqual({
      extensionDigit: 0,
      gs1Prefix: "460123456",
      serial: 12_345,
    });
  });

  it("round-trips the last serial in capacity", () => {
    const sscc = buildSscc(3, "4600682", 10 ** 9 - 1);
    expect(parseSscc(sscc, 7)).toEqual({
      extensionDigit: 3,
      gs1Prefix: "4600682",
      serial: 10 ** 9 - 1,
    });
  });

  it("returns null for a wrong-length payload", () => {
    expect(parseSscc("12345", 9)).toBeNull();
  });

  it("returns null for a bad check digit", () => {
    const sscc = buildSscc(0, "460123456", 1);
    const broken = sscc.slice(0, 17) + (sscc[17] === "0" ? "1" : "0");
    expect(parseSscc(broken, 9)).toBeNull();
  });

  it("throws SSCC_PREFIX on an out-of-range prefix length", () => {
    const sscc = buildSscc(0, "460123456", 1);
    expect(() => parseSscc(sscc, 3)).toThrowError(expect.objectContaining({ code: "SSCC_PREFIX" }));
    expect(() => parseSscc(sscc, 13)).toThrowError(
      expect.objectContaining({ code: "SSCC_PREFIX" }),
    );
  });
});

describe("formatSsccWithAi", () => {
  it("prepends the 00 application identifier to a bare 18-digit SSCC", () => {
    expect(formatSsccWithAi("346006820000000014")).toBe("00346006820000000014");
  });

  it.each([
    ["17 digits", "34600682000000001"],
    ["19 digits", "3460068200000000140"],
    ["already 00-prefixed 20 digits", "00346006820000000014"],
    ["non-digits", "34600682000000001X"],
    ["empty", ""],
  ])("throws SSCC_FORMAT on %s", (_name, value) => {
    expect(() => formatSsccWithAi(value)).toThrowError(DomainError);
    try {
      formatSsccWithAi(value);
    } catch (error) {
      expect((error as DomainError).code).toBe("SSCC_FORMAT");
    }
  });
});

describe("formatSsccHri", () => {
  it("formats a bare 18-digit SSCC as (00)…", () => {
    expect(formatSsccHri("346006820000000014")).toBe("(00)346006820000000014");
  });

  it("accepts an already 00-prefixed 20-digit value and formats the bare part", () => {
    expect(formatSsccHri("00346006820000000014")).toBe("(00)346006820000000014");
  });

  it("does NOT strip a leading 00 from a value that is itself a bare 18-digit SSCC", () => {
    // 18 digits starting with 00 is a bare SSCC (extension digit 0, prefix 0…),
    // not an AI-prefixed 16-digit tail.
    expect(formatSsccHri("004601234560000017")).toBe("(00)004601234560000017");
  });

  it.each([
    ["17 digits", "34600682000000001"],
    ["19 digits", "3460068200000000140"],
    ["20 digits without 00", "12346006820000000014"],
    ["non-digits", "34600682000000001X"],
    ["empty", ""],
  ])("throws SSCC_FORMAT on %s", (_name, value) => {
    expect(() => formatSsccHri(value)).toThrowError(DomainError);
  });
});
