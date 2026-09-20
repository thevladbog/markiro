import { describe, expect, it } from "vitest";

import {
  formatShiftTaskBarcode,
  parseShiftTaskBarcode,
  SHIFT_TASK_BARCODE_PREFIX,
} from "../src/barcodes/task-tokens.js";

const SHIFT_ID = "11111111-1111-4111-8111-111111111111";

describe("shift task barcode", () => {
  it("prefixes the shift id with the frozen v1 namespace", () => {
    expect(SHIFT_TASK_BARCODE_PREFIX).toBe("markiro:shift:v1:");
    expect(formatShiftTaskBarcode(SHIFT_ID)).toBe(`markiro:shift:v1:${SHIFT_ID}`);
  });

  it("round-trips its own output", () => {
    expect(parseShiftTaskBarcode(formatShiftTaskBarcode(SHIFT_ID))).toBe(SHIFT_ID);
  });

  it("refuses another namespace so an inventory form never opens a shift", () => {
    expect(parseShiftTaskBarcode(`markiro:inventory:v1:${SHIFT_ID}`)).toBeNull();
  });

  it("refuses a well-prefixed payload that is not a uuid", () => {
    expect(parseShiftTaskBarcode("markiro:shift:v1:not-a-uuid")).toBeNull();
    expect(parseShiftTaskBarcode("markiro:shift:v1:")).toBeNull();
  });

  it("refuses a bare uuid and unrelated production scans", () => {
    expect(parseShiftTaskBarcode(SHIFT_ID)).toBeNull();
    expect(parseShiftTaskBarcode("010468008990038321ABC93XYZ")).toBeNull();
  });

  it("normalises an uppercase uuid so one shift has one identity", () => {
    expect(parseShiftTaskBarcode(`markiro:shift:v1:${SHIFT_ID.toUpperCase()}`)).toBe(SHIFT_ID);
  });

  it("accepts every version nibble from 1 through 8", () => {
    const v6 = "11111111-1111-6111-8111-111111111111";
    const v8 = "11111111-1111-8111-8111-111111111111";
    expect(parseShiftTaskBarcode(`markiro:shift:v1:${v6}`)).toBe(v6);
    expect(parseShiftTaskBarcode(`markiro:shift:v1:${v8}`)).toBe(v8);
  });

  it("refuses a version or variant nibble outside the accepted range", () => {
    expect(
      parseShiftTaskBarcode("markiro:shift:v1:11111111-1111-9111-8111-111111111111"),
    ).toBeNull();
    expect(
      parseShiftTaskBarcode("markiro:shift:v1:11111111-1111-4111-c111-111111111111"),
    ).toBeNull();
  });

  it("mirrors ShiftTaskToken.kt: accepts the nil and max uuid sentinels in either case", () => {
    const nil = "00000000-0000-0000-0000-000000000000";
    const max = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(parseShiftTaskBarcode(`markiro:shift:v1:${nil}`)).toBe(nil);
    expect(parseShiftTaskBarcode(`markiro:shift:v1:${nil.toUpperCase()}`)).toBe(nil);
    expect(parseShiftTaskBarcode(`markiro:shift:v1:${max}`)).toBe(max);
    expect(parseShiftTaskBarcode(`markiro:shift:v1:${max.toUpperCase()}`)).toBe(max);
  });
});
