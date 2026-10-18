import { describe, expect, it } from "vitest";

import {
  EMERGENCY_MS,
  lastMomentBefore,
  licenseDay,
  licenseDayMonth,
  licenseMinute,
} from "../src/lib/license-dates.js";

describe("the license's dates", () => {
  it("name the last day «включительно» of an exclusive end in the organization's zone", () => {
    // 01.11.2027 00:00 in Moscow is the exclusive end: the last day is 31.10.
    expect(licenseDay("2027-10-31T21:00:00Z", "Europe/Moscow")).toBe("01.11.2027");
    expect(licenseDay(lastMomentBefore("2027-10-31T21:00:00Z"), "Europe/Moscow")).toBe(
      "31.10.2027",
    );
    expect(licenseDayMonth(lastMomentBefore("2026-10-24T09:00:00Z"), "Europe/Moscow")).toBe(
      "24.10",
    );
    // The same instant is already 01.11 in Vladivostok.
    expect(licenseDay(lastMomentBefore("2027-10-31T21:00:00Z"), "Asia/Vladivostok")).toBe(
      "01.11.2027",
    );
  });

  it("write a minute as «DD.MM HH:MM» on a 24-hour clock", () => {
    expect(licenseMinute("2026-10-23T06:00:00Z", "Europe/Moscow")).toBe("23.10 09:00");
    expect(licenseMinute("2026-10-23T21:05:00Z", "Europe/Moscow")).toBe("24.10 00:05");
  });

  it("use this PC's zone without one, or with one this PC lacks", () => {
    const instant = "2027-02-28T12:00:00Z";
    expect(licenseDay(instant, "Mars/Olympus")).toBe(licenseDay(instant, null));
    expect(licenseMinute(instant, "Mars/Olympus")).toBe(licenseMinute(instant, null));
  });

  it("know a leap year's last day and the 72 hours of the emergency", () => {
    expect(licenseDay(lastMomentBefore("2028-03-01T00:00:00Z"), "UTC")).toBe("29.02.2028");
    expect(lastMomentBefore("2028-03-01T00:00:00Z")).toBe("2028-02-29T23:59:59.999Z");
    expect(EMERGENCY_MS).toBe(259_200_000);
  });
});
