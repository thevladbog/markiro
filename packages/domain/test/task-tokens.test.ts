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
});
