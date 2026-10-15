import { describe, expect, it } from "vitest";
import { barMax, monthRange } from "../src/pages/tenants/diagnostics-format.js";

describe("diagnostics formatting bounds (Codex review 2)", () => {
  it("fills gaps between months, but never expands a huge span into thousands of rows", () => {
    expect(monthRange(["2026-01", "2026-04"])).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
    const wide = monthRange(["0000-01", "9999-12"]);
    expect(wide).toEqual(["0000-01", "9999-12"]);
    expect(monthRange(["2026-03", "2026-03", "2026-01"])).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(monthRange([])).toEqual([]);
  });

  it("finds the chart maximum without spreading the values into a call", () => {
    const values = Array.from({ length: 300_000 }, (_, at) => (at === 7 ? 42 : 1));
    expect(barMax([{ values }, { values: [null, 3] }])).toBe(42);
    expect(barMax([{ values: [null] }])).toBe(1);
  });
});
