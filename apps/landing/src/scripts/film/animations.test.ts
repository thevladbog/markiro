import { describe, expect, it } from "vitest";

import {
  animationAt,
  BELT,
  beltAt,
  CASE_CAPACITY,
  PALLET_CAPACITY,
  QUEUE_TILES,
} from "./animations";

const sweep = (from: number, to: number, step = 0.01) => {
  const times: number[] = [];
  for (let time = from; time <= to + 1e-9; time += step) times.push(time);
  return times;
};

describe("film animation state", () => {
  it("keeps every belt item on the belt and verifies it past the arch", () => {
    for (const time of sweep(0, 7, 0.1)) {
      for (const item of beltAt(time)) {
        expect(item.x).toBeGreaterThanOrEqual(BELT.start - 1e-9);
        expect(item.x).toBeLessThan(BELT.start + BELT.count * BELT.spacing);
        if (item.x <= BELT.archX) expect(item.code).toBe("idle");
        else expect(item.code).not.toBe("idle");
        if (item.aside > 0) expect(item.code).toBe("rejected");
      }
    }
  });

  it("changes the product on the belt from lap to lap", () => {
    const kinds = new Set(
      sweep(1, 2.2, 0.05).flatMap((time) => beltAt(time).map((item) => item.kind)),
    );
    expect(kinds).toEqual(new Set(["bottle", "jar", "can"]));
  });

  it("rejects some items and pushes them aside", () => {
    const rejected = sweep(1, 2.2, 0.05).flatMap((time) =>
      beltAt(time).filter((item) => item.code === "rejected"),
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.some((item) => item.aside > 0.5)).toBe(true);
  });

  it("fills the case, prints the label and grows the pallet in order", () => {
    let fill = 0;
    let pallet = 0;
    for (const time of sweep(1.8, 4)) {
      const state = animationAt(time);
      expect(state.caseFill).toBeGreaterThanOrEqual(fill);
      expect(state.palletCases).toBeGreaterThanOrEqual(pallet);
      expect(state.labelOut).toBeGreaterThanOrEqual(0);
      expect(state.labelOut).toBeLessThanOrEqual(1);
      fill = state.caseFill;
      pallet = state.palletCases;
    }
    expect(fill).toBe(CASE_CAPACITY);
    expect(pallet).toBe(PALLET_CAPACITY);
    expect(animationAt(2.9).labelOut).toBe(1);
  });

  it("completes the pallet while the camera holds on the handheld", () => {
    expect(animationAt(3.35).palletCases).toBeLessThan(PALLET_CAPACITY);
    expect(animationAt(3.4).palletCases).toBe(PALLET_CAPACITY);
  });

  it("goes offline in chapter five, queues operations and flushes them", () => {
    expect(animationAt(3.9).networkOnline).toBe(true);
    expect(animationAt(4.3).networkOnline).toBe(false);
    expect(animationAt(4.65).queueCount).toBe(QUEUE_TILES);
    expect(animationAt(4.65).queueFlush).toBe(0);
    expect(animationAt(4.8).networkOnline).toBe(true);
    expect(animationAt(5).queueFlush).toBe(1);
    expect(animationAt(3).queueCount).toBe(0);
  });

  it("walks the kiosk through its steps and lights the office", () => {
    expect(animationAt(5.1).kioskStep).toBe(0);
    expect(animationAt(5.9).kioskStep).toBe(3);
    expect(animationAt(5.9).officeLights).toBe(0);
    expect(animationAt(6.5).officeLights).toBe(1);
  });
});
