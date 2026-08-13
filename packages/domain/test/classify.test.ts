import { describe, expect, it } from "vitest";
import { classifyScan } from "../src/scan/classify.js";

describe("classifyScan", () => {
  it("classifies a KM DataMatrix", () => {
    const r = classifyScan("010460068200001321abcDEF1234567");
    expect(r.kind).toBe("km");
    if (r.kind === "km") expect(r.km.gtin14).toBe("04600682000013");
  });
  it("classifies a bare EAN-13 (shift creation scan)", () => {
    expect(classifyScan("4006381333931")).toEqual({
      kind: "gtin",
      gtin14: "04006381333931",
    });
  });
  it.each([
    "346006820000000014",
    "00346006820000000014",
    "(00)346006820000000014",
    "]C1346006820000000014",
    "]C100346006820000000014",
    "]C1(00)346006820000000014",
    "  ]C1(00)346006820000000014  ",
  ])("classifies scanner SSCC %s", (raw) => {
    expect(classifyScan(raw)).toEqual({
      kind: "sscc",
      sscc: "346006820000000014",
    });
  });

  it.each(["3460068200000000140", "]C1\u001d00346006820000000014", "]C1(00)3460068200000000140"])(
    "does not classify malformed scanner SSCC %s",
    (raw) => {
      expect(classifyScan(raw).kind).not.toBe("sscc");
    },
  );
  it("falls back to unknown", () => {
    expect(classifyScan("  hello world  ")).toEqual({
      kind: "unknown",
      raw: "  hello world  ",
    });
  });
});
