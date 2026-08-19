import { describe, expect, it } from "vitest";
import { DomainError, formatShiftNumber, shiftMonthKey } from "../src/index.js";

describe("shiftMonthKey", () => {
  it("maps an ISO calendar date to MONYY", () => {
    expect(shiftMonthKey("2026-08-20")).toBe("AUG26");
    expect(shiftMonthKey("2026-01-01")).toBe("JAN26");
    expect(shiftMonthKey("2029-12-31")).toBe("DEC29");
  });

  it("rejects malformed dates", () => {
    expect(() => shiftMonthKey("2026-13-01")).toThrow(DomainError);
    expect(() => shiftMonthKey("2026-8-1")).toThrow(DomainError);
    expect(() => shiftMonthKey("garbage")).toThrow(DomainError);
  });
});

describe("formatShiftNumber", () => {
  it("pads the sequence to three digits", () => {
    expect(formatShiftNumber({ monthKey: "AUG26", seq: 3, createdFrom: "admin" })).toBe(
      "AUG26-003",
    );
    expect(formatShiftNumber({ monthKey: "JAN27", seq: 42, createdFrom: "admin" })).toBe(
      "JAN27-042",
    );
  });

  it("appends /S for station-created shifts", () => {
    expect(formatShiftNumber({ monthKey: "AUG26", seq: 4, createdFrom: "station" })).toBe(
      "AUG26-004/S",
    );
  });

  it("never truncates a sequence past 999", () => {
    expect(formatShiftNumber({ monthKey: "AUG26", seq: 1234, createdFrom: "admin" })).toBe(
      "AUG26-1234",
    );
  });
});
