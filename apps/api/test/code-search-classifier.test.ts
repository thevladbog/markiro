import { describe, expect, it } from "vitest";
import { canonicalizeKm, isValidSscc, kmHash } from "@markiro/domain";
import { classifySearchInput } from "../src/modules/code-search/input-classifier";

// Same fixture SSCC as disaggregation-lines.e2e.test.ts / boxes.e2e.test.ts --
// a real, valid 18-digit SSCC.
const SSCC = "123456789012345675";
const VALID_GTIN14 = "04006381333931";
const KM = `01${VALID_GTIN14}21S-abc`;

describe("classifySearchInput", () => {
  it("uses a fixture SSCC with a valid check digit", () => {
    expect(isValidSscc(SSCC)).toBe(true);
  });

  it("classifies bare 18-digit SSCC", () => {
    expect(classifySearchInput(SSCC)).toEqual({ kind: "sscc", sscc: SSCC });
  });
  it("classifies 20-digit 00-prefixed and (00) HRI forms", () => {
    expect(classifySearchInput(`00${SSCC}`)).toEqual({ kind: "sscc", sscc: SSCC });
    expect(classifySearchInput(`(00)${SSCC}`)).toEqual({ kind: "sscc", sscc: SSCC });
    expect(classifySearchInput(` (00) ${SSCC} `)).toEqual({ kind: "sscc", sscc: SSCC });
  });
  it("classifies a KM to its hash", () => {
    expect(classifySearchInput(KM)).toEqual({ kind: "km", codeHash: kmHash(canonicalizeKm(KM)) });
  });
  it("classifies a digits-only fragment as a partial SSCC", () => {
    expect(classifySearchInput("345675")).toEqual({ kind: "partial-sscc", digits: "345675" });
    // Whitespace inside a typed fragment is stripped like it is for full SSCCs.
    expect(classifySearchInput(" 3456 75 ")).toEqual({ kind: "partial-sscc", digits: "345675" });
    // 18 digits with a WRONG check digit is not a full SSCC -- fall back to partial.
    expect(classifySearchInput("123456789012345670")).toEqual({
      kind: "partial-sscc",
      digits: "123456789012345670",
    });
  });

  it("keeps a full valid SSCC on the exact path, not the partial one", () => {
    expect(classifySearchInput(SSCC)).toEqual({ kind: "sscc", sscc: SSCC });
  });

  it("rejects garbage and too-short fragments", () => {
    expect(classifySearchInput("hello")).toEqual({ kind: "unrecognized" });
    expect(classifySearchInput("")).toEqual({ kind: "unrecognized" });
    expect(classifySearchInput("123")).toEqual({ kind: "unrecognized" });
  });
});
