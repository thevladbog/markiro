import { describe, expect, it } from "vitest";
import { validateShiftScan } from "../src/scan/validate.js";

const KM = "010460068200001321abcDEF1234567";
const KEY = "010460068200001321abcDEF1234567";
const ctx = (dupes: string[] = []) => ({
  expectedGtin14: "04600682000013",
  isDuplicate: (key: string) => dupes.includes(key),
});

describe("validateShiftScan", () => {
  it("accepts a fresh KM of the shift's product", () => {
    expect(validateShiftScan(KM, ctx())).toEqual({ status: "ok", key: KEY });
  });
  it("flags a duplicate via the injected lookup", () => {
    expect(validateShiftScan(KM, ctx([KEY]))).toEqual({
      status: "duplicate",
      key: KEY,
    });
  });
  it("flags a foreign GTIN", () => {
    const foreign = "010400638133393121Zz1";
    expect(validateShiftScan(foreign, ctx())).toEqual({
      status: "wrong_gtin",
      expectedGtin14: "04600682000013",
      actualGtin14: "04006381333931",
    });
  });
  it("flags structurally invalid scans", () => {
    expect(validateShiftScan("garbage", ctx())).toEqual({
      status: "invalid",
      raw: "garbage",
    });
  });
  it("treats an SSCC scan on the work screen as invalid input here", () => {
    expect(validateShiftScan("346006820000000014", ctx()).status).toBe("invalid");
  });
});
