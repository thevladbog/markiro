import { describe, expect, it } from "vitest";
import { DomainError, isTraceabilityCivilDate, parseTraceabilityQuantity } from "../src/index.js";

describe("receiving exact quantities", () => {
  it.each([
    [" 500.000 ", "500.000"],
    ["0.001", "0.001"],
    ["100", "100"],
    ["1.20", "1.20"],
    ["999999999999999.999", "999999999999999.999"],
  ])("preserves decimal precision for %s", (input, expected) => {
    expect(parseTraceabilityQuantity(input)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "0",
    "0.000",
    "-1",
    "+1",
    "1e3",
    "1E-3",
    "1,000",
    "1,5",
    "1.2345",
    "1000000000000000",
    "1000000000000000.000",
    "01",
    "00.1",
    ".5",
    "1.",
    "NaN",
    "Infinity",
    "１",
    "1 000",
    "1\u0000",
    "1.0001",
  ])("rejects %j without rounding or conversion", (input) => {
    expect(() => parseTraceabilityQuantity(input)).toThrow(DomainError);
    expect(() => parseTraceabilityQuantity(input)).toThrow(
      expect.objectContaining({ code: "QUANTITY_INVALID" }),
    );
  });
});

describe("receiving civil dates", () => {
  it.each([
    "0001-01-01",
    "9999-12-31",
    "2000-02-29",
    "2024-02-29",
    "2026-09-14",
    "2026-11-01",
    "2026-03-08",
  ])("accepts exact calendar date %s", (input) => {
    expect(isTraceabilityCivilDate(input)).toBe(true);
  });
  it.each([
    "0000-01-01",
    "10000-01-01",
    "1900-02-29",
    "2100-02-29",
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-01",
    "2026-01-00",
    "2026-01-32",
    "2026-9-14",
    "09/14/2026",
    " 2026-09-14 ",
    "2026-09-14T00:00:00Z",
    "",
    "2026-09-14\n",
  ])("rejects invalid date %j", (input) => {
    expect(isTraceabilityCivilDate(input)).toBe(false);
  });
});
