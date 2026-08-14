import { describe, expect, it } from "vitest";

import { formatDate } from "../src/lib/datetime.js";

describe("formatDate", () => {
  it("uses day-month-year for Russian and the matching locale for English", () => {
    expect(formatDate("2026-08-14", "ru")).toBe("14.08.2026");
    expect(formatDate("2026-08-14", "en")).toBe("08/14/2026");
  });
});
