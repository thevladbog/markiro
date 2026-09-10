import { describe, expect, it } from "vitest";
import { shelfLifeExpiryDate } from "../src/index.js";

describe("shelfLifeExpiryDate", () => {
  it.each([
    ["2026-09-10", 365, "2027-09-09"],
    ["2026-09-10", 1, "2026-09-10"],
    ["2026-12-31", 2, "2027-01-01"],
    ["2024-02-28", 2, "2024-02-29"],
    ["2024-02-29", 2, "2024-03-01"],
    ["2025-02-28", 2, "2025-03-01"],
    ["2023-09-10", 365, "2024-09-08"],
    ["0001-01-01", 1, "0001-01-01"],
    ["0099-12-31", 2, "0100-01-01"],
    ["9999-12-31", 1, "9999-12-31"],
    ["9999-12-31", 2, ""],
  ])("includes production day for %s, %i days", (date, days, expected) => {
    expect(shelfLifeExpiryDate(date, days)).toBe(expected);
  });

  it.each([null, 0, -1, 1.5, NaN, Infinity])("leaves expiry blank for shelf life %s", (days) => {
    expect(shelfLifeExpiryDate("2026-09-10", days)).toBe("");
  });

  it.each(["", "invalid", "2026-02-29", "2026-13-01", "0000-01-01", "2026-09-10T00:00:00Z"])(
    "leaves expiry blank for invalid production day %s",
    (date) => expect(shelfLifeExpiryDate(date, 365)).toBe(""),
  );
});
