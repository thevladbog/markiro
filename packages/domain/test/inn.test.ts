import { describe, expect, it } from "vitest";

import cases from "../fixtures/inn-cases.json" with { type: "json" };
import { isValidInn, normalizeInn } from "../src/inn.js";

describe("the INN (shared with the host's Rust port through inn-cases.json)", () => {
  it.each(cases)("answers $input", ({ input, normalized }) => {
    expect(normalizeInn(input)).toBe(normalized);
    // Strict: only a bare valid INN, nothing trimmed.
    expect(isValidInn(input)).toBe(normalized !== null && normalized === input);
  });

  it("checks both check digits of a 12-digit INN and the one of a 10-digit INN", () => {
    expect(isValidInn("7707083893")).toBe(true);
    expect(isValidInn("7707654321")).toBe(true);
    expect(isValidInn("500100732259")).toBe(true);
    // The first check digit (index 10) wrong, then the second (index 11).
    expect(isValidInn("500100732209")).toBe(false);
    expect(isValidInn("500100732250")).toBe(false);
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(isValidInn(`770708389${digit}`)).toBe(digit === 3);
    }
  });

  it("covers what the Rust port must agree on", () => {
    const inputs = cases.map((entry) => entry.input);
    // JavaScript's trim removes U+FEFF and keeps U+0085, unlike Rust's own trim.
    expect(inputs).toContain("\ufeff7707083893");
    expect(inputs).toContain("\u00857707083893");
    expect(cases.some((entry) => entry.normalized?.length === 12)).toBe(true);
    expect(cases.filter((entry) => entry.normalized === null).length).toBeGreaterThan(10);
  });
});
