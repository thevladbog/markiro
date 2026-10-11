import { describe, expect, it } from "vitest";

import { relativeLuminance } from "./color";
import { CHAPTER_TIME_OF_DAY, lightingAt, timeOfDayAt } from "./lighting";

describe("film lighting", () => {
  it("holds each chapter's time of day at its middle", () => {
    CHAPTER_TIME_OF_DAY.forEach((value, index) => {
      expect(timeOfDayAt(index + 0.5)).toBeCloseTo(value);
    });
    expect(timeOfDayAt(0)).toBeCloseTo(0.05);
    expect(timeOfDayAt(7)).toBeCloseTo(1);
  });

  it("only moves forward through the day", () => {
    let previous = 0;
    for (let time = 0; time <= 7; time += 0.05) {
      expect(timeOfDayAt(time)).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = timeOfDayAt(time);
    }
  });

  it("starts on the light page and ends on the dark one", () => {
    const morning = lightingAt(0);
    const night = lightingAt(1);
    expect(morning.background).toBe("#fafaf8");
    expect(night.background).toBe("#131216");
    expect(morning.uiTheme).toBe("light");
    expect(night.uiTheme).toBe("dark");
    expect(morning.lamps).toBe(0);
    expect(night.lamps).toBe(1);
    expect(morning.bloom).toBe(0);
    expect(night.glow).toBe(1);
    expect(morning.materialNight).toBe(0);
    expect(night.materialNight).toBeCloseTo(0.6);
    expect(morning.contactShadow).toBeCloseTo(0.24);
    expect(night.contactShadow).toBeCloseTo(0.55);
  });

  it("passes through every background stop", () => {
    expect(lightingAt(0.42).background).toBe("#f1eae1");
    expect(lightingAt(0.62).background).toBe("#6b6461");
    expect(lightingAt(0.82).background).toBe("#1e1c21");
  });

  it("darkens the background steadily, within 8-bit rounding", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let tod = 0; tod <= 1; tod += 0.02) {
      const luminance = relativeLuminance(lightingAt(tod).background);
      expect(luminance).toBeLessThanOrEqual(previous + 0.005);
      previous = luminance;
    }
  });

  it("switches the chrome to dark between chapters five and six", () => {
    expect(lightingAt(timeOfDayAt(4.5)).uiTheme).toBe("light");
    expect(lightingAt(timeOfDayAt(5.5)).uiTheme).toBe("dark");
  });
});
