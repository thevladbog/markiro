import { describe, expect, it } from "vitest";
import { assessClock, type TrustedClock } from "../src/offline-grants/clock.js";
const anchor: TrustedClock = {
  serverMs: 1000,
  monotonicMs: 100,
  bootId: "boot-1",
  highWaterMs: 1000,
  wallHighWaterMs: 1000,
};
const sample = { monotonicMs: 150, bootId: "boot-1", wallMs: 1050 };
describe("trusted clock", () => {
  it("advances only with boot-relative elapsed time", () => {
    expect(assessClock(anchor, { ...sample, wallMs: 999999 })).toEqual({
      trusted: true,
      now: 1050,
    });
  });
  it.each([
    { wallHighWaterMs: 900, wallMs: 950 },
    { wallHighWaterMs: 1100, wallMs: 1150 },
  ])("accepts a stable local/server wall offset %#", ({ wallHighWaterMs, wallMs }) => {
    expect(assessClock({ ...anchor, wallHighWaterMs }, { ...sample, wallMs })).toEqual({
      trusted: true,
      now: 1050,
    });
  });
  it.each([
    { bootId: "boot-2" },
    { bootId: "" },
    { monotonicMs: 99 },
    { wallMs: 999 },
    { monotonicMs: NaN },
    { monotonicMs: 150.5 },
    { wallMs: Infinity },
  ])("denies untrusted sample %j", (override) => {
    expect(assessClock(anchor, { ...sample, ...override })).toEqual({
      trusted: false,
      reason: "clock_untrusted",
    });
  });
  it.each([
    { serverMs: -1 },
    { highWaterMs: 999 },
    { highWaterMs: 1051 },
    { bootId: "" },
    { monotonicMs: Infinity },
    { wallHighWaterMs: -1 },
    { wallHighWaterMs: 1.5 },
  ])("denies invalid or regressed anchor %j", (override) => {
    expect(assessClock({ ...anchor, ...override }, sample)).toEqual({
      trusted: false,
      reason: "clock_untrusted",
    });
  });
  it("fails closed when the local-wall baseline is missing", () => {
    const missingBaseline = { ...anchor };
    Reflect.deleteProperty(missingBaseline, "wallHighWaterMs");

    expect(assessClock(missingBaseline, sample)).toEqual({
      trusted: false,
      reason: "clock_untrusted",
    });
  });
  it("persists a forward local-wall jump and rejects a later rollback", () => {
    expect(assessClock(anchor, { ...sample, wallMs: 5000 })).toEqual({
      trusted: true,
      now: 1050,
    });
    const persisted = { ...anchor, highWaterMs: 1050, wallHighWaterMs: 5000 };
    expect(assessClock(persisted, { ...sample, monotonicMs: 200, wallMs: 4999 })).toEqual({
      trusted: false,
      reason: "clock_untrusted",
    });
  });
  it("rejects server-time addition overflow after validating both high-water domains", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(
      assessClock(
        {
          ...anchor,
          serverMs: maximum,
          highWaterMs: maximum,
          wallHighWaterMs: 1000,
        },
        { ...sample, monotonicMs: 101, wallMs: 1001 },
      ),
    ).toEqual({ trusted: false, reason: "clock_untrusted" });
  });
  it("keeps the original anchor across process restart and honors persisted high-water", () => {
    const persisted = { ...anchor, highWaterMs: 1050, wallHighWaterMs: 1050 };
    expect(assessClock(persisted, { ...sample, monotonicMs: 200, wallMs: 1100 })).toEqual({
      trusted: true,
      now: 1100,
    });
    expect(assessClock(persisted, { ...sample, monotonicMs: 10 })).toEqual({
      trusted: false,
      reason: "clock_untrusted",
    });
  });
});
