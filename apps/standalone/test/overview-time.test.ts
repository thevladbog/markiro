import { describe, expect, it } from "vitest";

import {
  addCivilDays,
  civilDayLabel,
  civilHeading,
  recentCivilDays,
  relateToToday,
  zoneClock,
} from "../src/office/overview/overview-time.js";

describe("civil days of the overview", () => {
  it("adds days across month, year and leap-day boundaries", () => {
    expect(addCivilDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addCivilDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addCivilDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addCivilDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addCivilDays("2027-03-01", -1)).toBe("2027-02-28");
    expect(addCivilDays("2026-10-14", 0)).toBe("2026-10-14");
  });

  it("lists the last days oldest first, ending with today", () => {
    expect(recentCivilDays("2026-10-14", 7)).toEqual([
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
    ]);
    expect(recentCivilDays("2026-03-02", 3)).toEqual(["2026-02-28", "2026-03-01", "2026-03-02"]);
  });

  it("labels a civil date by weekday and day, whatever this PC's zone is", () => {
    expect(civilDayLabel("2026-10-14")).toEqual({ weekday: "ср", day: "14" });
    expect(civilDayLabel("2026-10-11")).toEqual({ weekday: "вс", day: "11" });
    expect(civilDayLabel("2028-02-29")).toEqual({ weekday: "вт", day: "29" });
  });

  it("writes the heading of a day with the weekday and month in words", () => {
    expect(civilHeading("2026-10-14")).toBe("Среда, 14 октября");
    expect(civilHeading("2026-10-15")).toBe("Четверг, 15 октября");
  });
});

describe("the organization's clock", () => {
  it("reads the wall time, the seconds and the offset of an instant in a zone", () => {
    const now = new Date("2026-10-14T11:32:08Z");
    expect(zoneClock(now, "Europe/Moscow")).toEqual({
      hm: "14:32",
      hms: "14:32:08",
      offset: "UTC+3",
    });
    expect(zoneClock(now, "Asia/Kolkata").offset).toBe("UTC+5:30");
    expect(zoneClock(now, "UTC")).toEqual({ hm: "11:32", hms: "11:32:08", offset: "UTC" });
  });

  it("is midnight at 00 and not 24 across the day's edge", () => {
    expect(zoneClock(new Date("2026-10-13T21:05:00Z"), "Europe/Moscow").hm).toBe("00:05");
  });

  it("follows a zone that has summer time", () => {
    expect(zoneClock(new Date("2026-07-01T12:00:00Z"), "Europe/Berlin").offset).toBe("UTC+2");
    expect(zoneClock(new Date("2026-12-01T12:00:00Z"), "Europe/Berlin").offset).toBe("UTC+1");
  });

  it("falls back to this PC's zone without a known one", () => {
    const now = new Date("2026-10-14T11:32:08Z");
    expect(zoneClock(now, null).hms).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(zoneClock(now, "Nowhere/Land").hms).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});

describe("an instant against the organization's today", () => {
  it("reads «today» and «yesterday» by the organization's calendar, not UTC", () => {
    // 21:30 UTC on the 13th is 00:30 on the 14th in Moscow.
    const night = new Date("2026-10-13T21:30:00Z");
    expect(relateToToday(night, "Europe/Moscow", "2026-10-14")).toEqual({
      day: "today",
      hm: "00:30",
    });
    expect(relateToToday(night, "UTC", "2026-10-14")).toEqual({ day: "yesterday", hm: "21:30" });
    expect(relateToToday(new Date("2026-10-10T09:00:00Z"), "UTC", "2026-10-14").day).toBe("other");
  });

  it("crosses a month and a year boundary", () => {
    expect(relateToToday(new Date("2026-12-31T20:00:00Z"), "UTC", "2027-01-01").day).toBe(
      "yesterday",
    );
    expect(relateToToday(new Date("2028-02-29T12:00:00Z"), "UTC", "2028-03-01").day).toBe(
      "yesterday",
    );
  });
});
