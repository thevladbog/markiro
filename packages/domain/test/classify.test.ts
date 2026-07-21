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
  it("classifies an SSCC label scan, with and without AI 00", () => {
    expect(classifyScan("346006820000000014")).toEqual({
      kind: "sscc",
      sscc: "346006820000000014",
    });
    expect(classifyScan("00346006820000000014")).toEqual({
      kind: "sscc",
      sscc: "346006820000000014",
    });
  });
  it("falls back to unknown", () => {
    expect(classifyScan("hello world")).toEqual({
      kind: "unknown",
      raw: "hello world",
    });
  });
});
