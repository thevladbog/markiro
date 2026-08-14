import { describe, expect, it } from "vitest";
import {
  isShiftCloseReasonCode,
  shiftCloseReasonRequired,
} from "../src/shift-close.js";

describe("station shift close contract", () => {
  it("does not require a reason when a plan is absent or exactly met", () => {
    expect(shiftCloseReasonRequired(null, 12)).toBe(false);
    expect(shiftCloseReasonRequired(12, 12)).toBe(false);
  });

  it("requires a reason only for a planned-versus-actual mismatch", () => {
    expect(shiftCloseReasonRequired(12, 11)).toBe(true);
    expect(shiftCloseReasonRequired(12, 13)).toBe(true);
  });

  it("accepts only a fixed reason code vocabulary", () => {
    expect(isShiftCloseReasonCode("equipment_stop")).toBe(true);
    expect(isShiftCloseReasonCode("operator typed arbitrary text")).toBe(false);
    expect(isShiftCloseReasonCode(null)).toBe(false);
  });
});
