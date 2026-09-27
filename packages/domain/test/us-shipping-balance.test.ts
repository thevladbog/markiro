import { describe, expect, it } from "vitest";
import { computeShippingBalance, projectShippingRemaining } from "../src/index.js";

it("forecasts exact remaining and distinguishes unknown, zero, mismatch and over-shipment", () => {
  const known = {
    state: "known" as const,
    unitOfMeasure: "case",
    supply: "100",
    used: "39.999",
    remaining: "60.001",
  };
  expect(projectShippingRemaining(known, "60", "case")).toEqual({
    state: "known",
    projectedRemaining: "0.001",
  });
  expect(projectShippingRemaining(known, "60.002", "case")).toEqual({
    state: "over_shipment",
    projectedRemaining: "-0.001",
  });
  expect(projectShippingRemaining({ ...known, remaining: "0" }, "1", "case")).toEqual({
    state: "exhausted",
  });
  expect(projectShippingRemaining(known, "1", "lb")).toEqual({
    state: "uom_mismatch",
    expectedUnit: "case",
  });
  expect(projectShippingRemaining(known, "1.0001", "case")).toEqual({ state: "invalid_quantity" });
  expect(projectShippingRemaining({ state: "unknown", reason: "mixed_uom" }, "1", "case")).toEqual({
    state: "unknown",
    reason: "mixed_uom",
  });
});

describe("Shipping lot balance", () => {
  it("adds every current Receiving contribution and subtracts a partial Shipping use", () => {
    expect(
      computeShippingBalance({
        contributions: [
          { quantity: "50", unitOfMeasure: "case" },
          { quantity: "50", unitOfMeasure: "case" },
        ],
        deductions: [{ quantity: "25", unitOfMeasure: "case" }],
      }),
    ).toEqual({
      state: "known",
      unitOfMeasure: "case",
      supply: "100",
      used: "25",
      remaining: "75",
    });
  });

  it("combines current Transformation output and use supplied by the caller", () => {
    expect(
      computeShippingBalance({
        contributions: [{ quantity: "100.125", unitOfMeasure: "case" }],
        deductions: [{ quantity: "0.125", unitOfMeasure: "case" }],
      }),
    ).toEqual({
      state: "known",
      unitOfMeasure: "case",
      supply: "100.125",
      used: "0.125",
      remaining: "100",
    });
  });

  it("uses only current rows selected by the caller; void and superseded rows are excluded", () => {
    const currentRows = {
      contributions: [{ quantity: "50", unitOfMeasure: "case" }],
      deductions: [{ quantity: "25", unitOfMeasure: "case" }],
    };
    expect(computeShippingBalance(currentRows)).toEqual({
      state: "known",
      unitOfMeasure: "case",
      supply: "50",
      used: "25",
      remaining: "25",
    });
  });

  it("reports no current origin even when deductions exist", () => {
    expect(
      computeShippingBalance({
        contributions: [],
        deductions: [{ quantity: "1", unitOfMeasure: "case" }],
      }),
    ).toEqual({
      state: "unknown",
      reason: "no_current_origin",
    });
  });

  it("reports mixed units instead of making a partial sum", () => {
    expect(
      computeShippingBalance({
        contributions: [
          { quantity: "100", unitOfMeasure: "case" },
          { quantity: "1", unitOfMeasure: "each" },
        ],
        deductions: [],
      }),
    ).toEqual({ state: "unknown", reason: "mixed_uom" });
    expect(
      computeShippingBalance({
        contributions: [{ quantity: "100", unitOfMeasure: "case" }],
        deductions: [{ quantity: "1", unitOfMeasure: "each" }],
      }),
    ).toEqual({ state: "unknown", reason: "mixed_uom" });
  });

  it.each(["1.0001", "0", "-1", "not-a-number", "1e3", "1.000.0", "9999999999999999"])(
    "reports invalid quantity evidence %s",
    (quantity) => {
      expect(
        computeShippingBalance({
          contributions: [{ quantity, unitOfMeasure: "case" }],
          deductions: [],
        }),
      ).toEqual({ state: "unknown", reason: "invalid_quantity" });
    },
  );

  it("reports overflow for sums outside numeric(18,3)", () => {
    expect(
      computeShippingBalance({
        contributions: [
          { quantity: "999999999999999.999", unitOfMeasure: "case" },
          { quantity: "0.001", unitOfMeasure: "case" },
        ],
        deductions: [],
      }),
    ).toEqual({ state: "unknown", reason: "overflow" });
    expect(
      computeShippingBalance({
        contributions: [{ quantity: "1", unitOfMeasure: "case" }],
        deductions: [
          { quantity: "999999999999999.999", unitOfMeasure: "case" },
          { quantity: "0.001", unitOfMeasure: "case" },
        ],
      }),
    ).toEqual({ state: "unknown", reason: "overflow" });
  });

  it("keeps exact zero and negative recorded balances distinct", () => {
    expect(
      computeShippingBalance({
        contributions: [{ quantity: "0.001", unitOfMeasure: "case" }],
        deductions: [{ quantity: "0.001", unitOfMeasure: "case" }],
      }),
    ).toEqual({
      state: "known",
      unitOfMeasure: "case",
      supply: "0.001",
      used: "0.001",
      remaining: "0",
    });
    expect(
      computeShippingBalance({
        contributions: [{ quantity: "1", unitOfMeasure: "case" }],
        deductions: [{ quantity: "1.001", unitOfMeasure: "case" }],
      }),
    ).toEqual({
      state: "known",
      unitOfMeasure: "case",
      supply: "1",
      used: "1.001",
      remaining: "-0.001",
    });
  });
});
