import { describe, expect, it } from "vitest";

import {
  addCivilDays,
  formatCivilDate,
  formatClock,
  formatQuantity,
} from "../src/floor/shifts/shift-text.js";

describe("the floor's words for dates and counts", () => {
  it("shows a civil date day first, as written, never through a clock", () => {
    expect(formatCivilDate("2026-10-09")).toBe("09.10.2026");
    expect(formatCivilDate("0099-01-02")).toBe("02.01.0099");
  });

  it("moves a civil date by whole days over months, years and a leap day", () => {
    expect(addCivilDays("2026-10-09", 1)).toBe("2026-10-10");
    expect(addCivilDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addCivilDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCivilDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addCivilDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addCivilDays("2100-02-28", 1)).toBe("2100-03-01");
    // `Date.UTC` would take the year 99 for 1999.
    expect(addCivilDays("0099-12-31", 1)).toBe("0100-01-01");
  });

  it("parts the thousands of a count with a no-break space", () => {
    expect(formatQuantity(1200)).toBe("1\u00a0200");
    expect(formatQuantity(12)).toBe("12");
  });
});

it("says an instant as «ЧЧ:ММ» on this computer's clock, and an unreadable one as it is (plan 2b)", () => {
  const at = "2026-10-08T09:41:07Z";
  const local = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  expect(formatClock(at)).toBe(`${pad(local.getHours())}:${pad(local.getMinutes())}`);
  expect(formatClock("вчера")).toBe("вчера");
});
