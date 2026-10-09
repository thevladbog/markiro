import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { civilDaysBetween, civilToday, isCivilDate } from "../src/lib/civil-date.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/** The dates of `shift-numbers.json`: the host takes those with a month key and refuses the rest. */
const DATES = z
  .object({ monthKeys: z.array(z.object({ date: z.string(), monthKey: z.string().nullable() })) })
  .parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-numbers.json", testModuleUrl), "utf8"),
    ),
  ).monthKeys;

describe("civil dates", () => {
  it.each(DATES.map((each) => [each.date, each.monthKey !== null] as const))(
    "reads %j as the host does: taken %s",
    (date, taken) => {
      expect(isCivilDate(date)).toBe(taken);
    },
  );

  it("refuses the year 0000, which the host refuses and the fixture leaves out, and takes 0001 and 9999", () => {
    expect(isCivilDate("0000-01-01")).toBe(false);
    expect(isCivilDate("0001-01-01")).toBe(true);
    expect(isCivilDate("9999-12-31")).toBe(true);
    // Every month's last day, and the one after it.
    const last = ["31", "28", "31", "30", "31", "30", "31", "31", "30", "31", "30", "31"];
    last.forEach((day, index) => {
      const month = String(index + 1).padStart(2, "0");
      expect(isCivilDate(`2026-${month}-${day}`), `2026-${month}-${day}`).toBe(true);
      const after = String(Number(day) + 1);
      expect(isCivilDate(`2026-${month}-${after}`), `2026-${month}-${after}`).toBe(false);
    });
  });

  it("refuses a date whose parts are not exactly 4-2-2 digits, however the fixture's examples are spelled", () => {
    for (const text of [
      "26-10-08",
      "026-10-08",
      "20260-10-08",
      "2026-8-01",
      "2026-08-1",
      "2026-100-08",
      "2026-10-008",
      "2026/10/08",
      "2026-10-08-",
    ]) {
      expect(isCivilDate(text), text).toBe(false);
    }
  });

  it("counts the days between two dates across a month, a leap day, a year and the first years", () => {
    expect(civilDaysBetween("2026-10-08", "2026-10-08")).toBe(0);
    expect(civilDaysBetween("2026-10-08", "2026-10-09")).toBe(1);
    expect(civilDaysBetween("2026-10-09", "2026-10-08")).toBe(-1);
    expect(civilDaysBetween("2026-09-30", "2026-10-01")).toBe(1);
    expect(civilDaysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(civilDaysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(civilDaysBetween("2026-01-01", "2027-01-01")).toBe(365);
    expect(civilDaysBetween("2028-01-01", "2029-01-01")).toBe(366);
    // `Date.UTC` would read the year 24 as 1924; the days of 0024 are counted as they are.
    expect(civilDaysBetween("0024-02-28", "0024-03-01")).toBe(2);
    expect(civilDaysBetween("0099-12-31", "0100-01-01")).toBe(1);
    // The whole span the host takes, 0001-01-01 to 9999-12-31, in the proleptic Gregorian calendar.
    expect(civilDaysBetween("0001-01-01", "9999-12-31")).toBe(3_652_058);
    expect(civilDaysBetween("1900-02-28", "1900-03-01")).toBe(1);
    expect(civilDaysBetween("2000-02-28", "2000-03-01")).toBe(2);
    // A whole year counted with both ends: 366 dates in a leap year, 365 in a common one.
    expect(civilDaysBetween("2028-01-01", "2028-12-31") + 1).toBe(366);
    expect(civilDaysBetween("2027-01-01", "2027-12-31") + 1).toBe(365);
    expect(() => civilDaysBetween("2026-02-30", "2026-03-01")).toThrow(RangeError);
  });

  it("gives today's date in the organization's zone, not this PC's", () => {
    const evening = new Date("2026-10-08T21:30:00Z");
    expect(civilToday("Europe/Moscow", evening)).toBe("2026-10-09");
    expect(civilToday("UTC", evening)).toBe("2026-10-08");
    expect(civilToday("America/New_York", new Date("2026-10-09T02:00:00Z"))).toBe("2026-10-08");
    expect(civilToday("Asia/Kamchatka", new Date("2026-12-31T12:30:00Z"))).toBe("2027-01-01");
  });

  it("changes the date at the zone's midnight, to the second", () => {
    expect(civilToday("Europe/Moscow", new Date("2026-10-08T20:59:59Z"))).toBe("2026-10-08");
    expect(civilToday("Europe/Moscow", new Date("2026-10-08T21:00:00Z"))).toBe("2026-10-09");
    // New York leaves daylight time on 2026-11-01 at 06:00Z: midnight is still UTC-4, the next one UTC-5.
    expect(civilToday("America/New_York", new Date("2026-11-01T03:59:59Z"))).toBe("2026-10-31");
    expect(civilToday("America/New_York", new Date("2026-11-01T04:00:00Z"))).toBe("2026-11-01");
    expect(civilToday("America/New_York", new Date("2026-11-02T04:59:59Z"))).toBe("2026-11-01");
    expect(civilToday("America/New_York", new Date("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
  });

  it("pads the year to four digits and the month and day to two", () => {
    expect(civilToday("UTC", new Date("0999-03-05T12:00:00Z"))).toBe("0999-03-05");
    expect(civilToday("Europe/Moscow", new Date("2026-01-05T12:00:00Z"))).toBe("2026-01-05");
    const local = new Date(2000, 0, 1, 12);
    local.setFullYear(999, 2, 5);
    expect(civilToday(null, local)).toBe("0999-03-05");
  });

  it("reads the clock when it is given no instant", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-08T21:30:00Z"));
      expect(civilToday("Europe/Moscow")).toBe("2026-10-09");
      expect(civilToday("UTC")).toBe("2026-10-08");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to this PC's date without a zone or with one the runtime does not know", () => {
    const now = new Date(2026, 9, 8, 23, 59);
    expect(civilToday(null, now)).toBe("2026-10-08");
    expect(civilToday("Mars/Olympus_Mons", now)).toBe("2026-10-08");
  });

  it("falls back to the PC's own calendar day, not the UTC day, when the two differ", () => {
    // Kiritimati is UTC+14 all year: 12:00Z on the 8th is 02:00 on the 9th there.
    const zone = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      const instant = new Date("2026-10-08T12:00:00Z");
      expect(instant.getDate()).toBe(9);
      expect(civilToday(null, instant)).toBe("2026-10-09");
      expect(civilToday("UTC", instant)).toBe("2026-10-08");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
