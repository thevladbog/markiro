import { describe, expect, it } from "vitest";
import {
  buildSscc,
  canonicalizeKm,
  classifyScan,
  kmHash,
  resolveWarehouseReprintScan,
  compareWarehouseReprintLabel,
} from "../src/index.js";

const sscc = "346006820000000014";
const fullKm = "010460068200001321abc!1DEF123456\u001d93crypto!1tail";

describe("warehouse reprint scan", () => {
  it.each([`!100${sscc}`, `]C0!100${sscc}`, `]C1!100${sscc}`, `  !100${sscc}  `])(
    "resolves a damaged TSPL label %s to its original SSCC",
    (raw) => {
      expect(resolveWarehouseReprintScan(raw)).toEqual({
        kind: "box",
        sscc,
        repair: "legacy_tspl_fnc1_literal",
      });
    },
  );
  it.each([sscc, `00${sscc}`, `(00)${sscc}`, `]C100${sscc}`])(
    "resolves a correct label %s to the same identity",
    (raw) => expect(resolveWarehouseReprintScan(raw)).toEqual({ kind: "box", sscc, repair: null }),
  );
  it.each([
    `!1!100${sscc}`,
    `!101${sscc}`,
    `!100${sscc}0`,
    "!100346006820000000015",
    "!1010460068200001321abc",
    `]C0!1${sscc}`,
    "hello",
    "4006381333931",
  ])("does not repair malformed input %s", (raw) => {
    expect(resolveWarehouseReprintScan(raw)).toEqual({ kind: "invalid" });
  });
  it("preserves leading zeroes of the SSCC", () => {
    const zeroSscc = buildSscc(0, "012345678", 1);
    expect(zeroSscc.startsWith("00")).toBe(true);
    expect(resolveWarehouseReprintScan(`!100${zeroSscc}`)).toEqual({
      kind: "box",
      sscc: zeroSscc,
      repair: "legacy_tspl_fnc1_literal",
    });
  });
  it("does not alter !1 inside a valid marking code", () => {
    expect(resolveWarehouseReprintScan(fullKm)).toEqual({
      kind: "unit",
      codeHash: kmHash(canonicalizeKm(fullKm)),
    });
    expect(compareWarehouseReprintLabel({ kind: "unit", canonicalRaw: fullKm }, fullKm)).toBe(
      "match",
    );
    expect(
      compareWarehouseReprintLabel(
        { kind: "unit", canonicalRaw: fullKm },
        fullKm.replace("crypto!1tail", "cryptotail"),
      ),
    ).toBe("mismatch");
  });
  it("does not relax the ordinary production scan parser", () => {
    expect(classifyScan(`!100${sscc}`).kind).not.toBe("sscc");
  });
  it("refuses the old defective label as verification of a corrected print", () => {
    expect(compareWarehouseReprintLabel({ kind: "box", sscc }, `!100${sscc}`)).toBe("invalid");
    expect(compareWarehouseReprintLabel({ kind: "box", sscc }, `]C100${sscc}`)).toBe("match");
    expect(compareWarehouseReprintLabel({ kind: "box", sscc }, "00346006820000000427")).toBe(
      "mismatch",
    );
  });
});
