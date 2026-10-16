import { describe, expect, it } from "vitest";

import { OPERATOR_LOCKOUT, STATION_LOCKOUT } from "../src/floor/lockout.js";
import {
  formatCountdown,
  lockAnnouncement,
  lockFraction,
  lockTotalMs,
  lockViewAfterEdit,
  remainingOf,
  type LockView,
} from "../src/floor/sign-in/lock-view.js";

describe("the lockout countdown's text", () => {
  it("is minutes and seconds, the seconds rounded up so it never shows 00:00 while locked", () => {
    expect(formatCountdown(272_000)).toBe("04:32");
    expect(formatCountdown(300_000)).toBe("05:00");
    expect(formatCountdown(60_000)).toBe("01:00");
    expect(formatCountdown(59_001)).toBe("01:00");
    expect(formatCountdown(59_000)).toBe("00:59");
    expect(formatCountdown(1)).toBe("00:01");
  });

  it("stops at 00:00, for a time already past and for a nonsense one", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-5_000)).toBe("00:00");
    expect(formatCountdown(Number.NaN)).toBe("00:00");
  });

  it("measures what is left against the lockout's own length (the policies' constants, not copies)", () => {
    expect(lockTotalMs("station")).toBe(STATION_LOCKOUT.durationMs);
    expect(lockTotalMs("operator")).toBe(OPERATOR_LOCKOUT.durationMs);
    expect(lockFraction(150_000, 300_000)).toBe(0.5);
    expect(lockFraction(400_000, 300_000)).toBe(1);
    expect(lockFraction(-1, 300_000)).toBe(0);
    expect(lockFraction(10, 0)).toBe(0);
  });

  it("reads what is left from this computer's clock", () => {
    const lock: LockView = { scope: "operator", login: "0042", endsAt: 1_000_000 };
    expect(remainingOf(lock, () => 940_000)).toBe(60_000);
    expect(remainingOf(lock, () => 1_000_001)).toBe(0);
  });
});

describe("what a screen reader is told of a lockout", () => {
  const station: LockView = { scope: "station", login: null, endsAt: 100 };
  const operator: LockView = { scope: "operator", login: "0042", endsAt: 100 };

  it("hears it once when it starts and once when it ends, and nothing between", () => {
    expect(lockAnnouncement(null, station, 50)).toBe("started");
    expect(lockAnnouncement(station, station, 60)).toBeNull();
    expect(lockAnnouncement(station, station, 99)).toBeNull();
    expect(lockAnnouncement(station, station, 100)).toBe("ended");
    expect(lockAnnouncement(station, null, 80)).toBeNull();
  });

  it("hears a new lockout of another scope or number as a new start", () => {
    expect(lockAnnouncement(station, operator, 50)).toBe("started");
    expect(lockAnnouncement(operator, { ...operator, login: "0077" }, 50)).toBe("started");
    expect(lockAnnouncement(operator, { ...operator, endsAt: 130 }, 50)).toBeNull();
  });

  it("says nothing about a lockout that is already over when it is first seen", () => {
    expect(lockAnnouncement(null, station, 100)).toBeNull();
    expect(lockAnnouncement(null, null, 100)).toBeNull();
  });
});

describe("whose lockout the keypad respects", () => {
  const operator: LockView = { scope: "operator", login: "0042", endsAt: 100 };

  it("keeps an operator's lockout while the number is still theirs, and lets go of it for another number", () => {
    expect(lockViewAfterEdit(operator, "0042")).toBe(operator);
    expect(lockViewAfterEdit(operator, "004")).toBeNull();
    expect(lockViewAfterEdit(operator, "0077")).toBeNull();
  });

  it("never lets go of the station's lockout by an edit", () => {
    const station: LockView = { scope: "station", login: null, endsAt: 100 };
    expect(lockViewAfterEdit(station, "9999")).toBe(station);
    expect(lockViewAfterEdit(null, "9999")).toBeNull();
  });
});
