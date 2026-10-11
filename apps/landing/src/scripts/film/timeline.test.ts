import { describe, expect, it } from "vitest";

import { cameraTime, chapterAt, dwell, filmTimeFromLayout } from "./timeline";

const VIEWPORT = 1000;
const SPANS = [2.6, 1.3, 1.3, 1.35, 1.45, 1.35, 1.6];
const STARTS = SPANS.map((_, index) =>
  SPANS.slice(0, index).reduce((sum, span) => sum + span * VIEWPORT, 0),
);
const TOTAL_SCROLL = SPANS.reduce((sum, span) => sum + span * VIEWPORT, 0) - VIEWPORT;

function layoutAt(scrollY: number) {
  return SPANS.map((span, index) => ({
    top: (STARTS[index] ?? 0) - scrollY,
    height: span * VIEWPORT,
  }));
}

const timeAt = (scrollY: number) => filmTimeFromLayout(layoutAt(scrollY), VIEWPORT);

describe("film timeline", () => {
  it("starts at zero at the top of the page", () => {
    expect(timeAt(0)).toBe(0);
  });

  it("runs the first chapter until the second enters from the bottom", () => {
    expect(timeAt(800)).toBeCloseTo(0.5);
    expect(timeAt(1600)).toBeCloseTo(1);
  });

  it("starts every later chapter exactly when its section enters at the bottom", () => {
    for (let chapter = 1; chapter < SPANS.length; chapter += 1) {
      expect(timeAt((STARTS[chapter] ?? 0) - VIEWPORT)).toBeCloseTo(chapter);
    }
    expect(timeAt(2600 - VIEWPORT + 650)).toBeCloseTo(1.5);
  });

  it("clamps above and below the film", () => {
    expect(timeAt(-400)).toBe(0);
    expect(timeAt(TOTAL_SCROLL)).toBeCloseTo(7);
    expect(timeAt(TOTAL_SCROLL + 5000)).toBe(7);
  });

  it("moves forward while scrolling down and backward while scrolling up", () => {
    let previous = 0;
    for (let scrollY = 0; scrollY <= TOTAL_SCROLL; scrollY += 37) {
      expect(timeAt(scrollY)).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = timeAt(scrollY);
    }
    previous = 7;
    for (let scrollY = TOTAL_SCROLL; scrollY >= 0; scrollY -= 41) {
      expect(timeAt(scrollY)).toBeLessThanOrEqual(previous + 1e-9);
      previous = timeAt(scrollY);
    }
  });

  it("splits film time into chapter and local progress", () => {
    expect(chapterAt(3.25, 7)).toEqual({ index: 3, local: 0.25 });
    expect(chapterAt(7, 7)).toEqual({ index: 6, local: 1 });
    expect(chapterAt(-1, 7)).toEqual({ index: 0, local: 0 });
  });

  it("slows the camera mid-chapter and keeps the joins smooth", () => {
    expect(dwell(0)).toBe(0);
    expect(dwell(1)).toBeCloseTo(1);
    expect(dwell(0.5)).toBeCloseTo(0.5);
    const slope = (x: number) => (dwell(x + 1e-4) - dwell(x - 1e-4)) / 2e-4;
    expect(slope(0.5)).toBeLessThan(slope(0.05));
    let previous = 0;
    for (let x = 0; x <= 1; x += 0.01) {
      expect(dwell(x)).toBeGreaterThanOrEqual(previous);
      previous = dwell(x);
    }
    expect(cameraTime(2 - 1e-9, 7)).toBeCloseTo(cameraTime(2 + 1e-9, 7), 6);
    expect(cameraTime(7, 7)).toBeCloseTo(7);
  });
});
