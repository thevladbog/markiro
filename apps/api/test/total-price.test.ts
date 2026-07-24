import { describe, expect, it } from "vitest";
import { computeTotalPrice } from "../src/pickup/total-price";

describe("computeTotalPrice", () => {
  it("returns null for an empty item list", () => {
    expect(computeTotalPrice([])).toBeNull();
  });

  it("returns null when any item is unpriced", () => {
    expect(computeTotalPrice([{ unitPrice: "10.00" }, { unitPrice: null }])).toBeNull();
  });

  it("formats a single price as a 2-decimal string", () => {
    expect(computeTotalPrice([{ unitPrice: "99.90" }])).toBe("99.90");
  });

  it("sums multiple prices exactly", () => {
    expect(computeTotalPrice([{ unitPrice: "52.00" }, { unitPrice: "74.00" }])).toBe("126.00");
  });

  it("accumulates in integer cents, not binary float", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754; integer cents stay exact.
    expect(computeTotalPrice([{ unitPrice: "0.10" }, { unitPrice: "0.20" }])).toBe("0.30");
    const tenths = Array.from({ length: 10 }, () => ({ unitPrice: "0.10" }));
    expect(computeTotalPrice(tenths)).toBe("1.00");
  });

  it("pads the kopeck fraction to two digits", () => {
    expect(computeTotalPrice([{ unitPrice: "5.05" }])).toBe("5.05");
    expect(computeTotalPrice([{ unitPrice: "5.00" }])).toBe("5.00");
  });

  it("parses the decimal string exactly, rounding half away from zero at the kopeck", () => {
    // Number("1.005") * 100 === 100.4999… would truncate to "1.00"; exact
    // decimal parsing rounds to "1.01" (matching the numeric(_,2) column).
    expect(computeTotalPrice([{ unitPrice: "1.005" }])).toBe("1.01");
    expect(computeTotalPrice([{ unitPrice: "1.004" }])).toBe("1.00");
  });
});
