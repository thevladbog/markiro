import { describe, expect, it } from "vitest";
import { currentMonthUTC, nextMonthUTC } from "../src/jobs/months";

describe("currentMonthUTC", () => {
  it("returns the first instant of now's UTC month", () => {
    const now = new Date(Date.UTC(2026, 6, 15, 12, 30));
    expect(currentMonthUTC(now)).toEqual(new Date(Date.UTC(2026, 6, 1)));
  });

  it("defaults to the current time when no argument is given", () => {
    const result = currentMonthUTC();
    const expected = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    expect(result).toEqual(expected);
  });
});

describe("nextMonthUTC", () => {
  it("returns the first instant of the following UTC month", () => {
    const now = new Date(Date.UTC(2026, 6, 15));
    expect(nextMonthUTC(now)).toEqual(new Date(Date.UTC(2026, 7, 1)));
  });

  it("rolls a December date over into January of the next year", () => {
    const now = new Date(Date.UTC(2026, 11, 31, 23, 59));
    expect(currentMonthUTC(now)).toEqual(new Date(Date.UTC(2026, 11, 1)));
    expect(nextMonthUTC(now)).toEqual(new Date(Date.UTC(2027, 0, 1)));
  });
});
