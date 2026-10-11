import { describe, expect, it } from "vitest";

import { chooseTier, createFrameBudget, TIER_SETTINGS } from "./quality";

describe("film quality", () => {
  it("picks a tier from device hints", () => {
    expect(chooseTier({ coarsePointer: false, deviceMemory: 8, cores: 8 })).toBe("high");
    expect(chooseTier({ coarsePointer: true, deviceMemory: 8, cores: 8 })).toBe("mid");
    expect(chooseTier({ coarsePointer: false, deviceMemory: 2, cores: 8 })).toBe("low");
    expect(chooseTier({ coarsePointer: true, deviceMemory: null, cores: 2 })).toBe("low");
    expect(chooseTier({ coarsePointer: false, deviceMemory: null, cores: null })).toBe("high");
  });

  it("drops ambient occlusion on phones and bloom on weak devices", () => {
    expect(TIER_SETTINGS.high.ambientOcclusion).toBe(true);
    expect(TIER_SETTINGS.mid.ambientOcclusion).toBe(false);
    expect(TIER_SETTINGS.low.bloom).toBe(false);
    expect(TIER_SETTINGS.high.pixelRatioCap).toBe(2);
    expect(TIER_SETTINGS.mid.pixelRatioCap).toBe(1.5);
  });

  it("measures for two seconds, then judges the median frame once", () => {
    const fast = createFrameBudget();
    let verdict = fast.push(16, 0);
    for (let now = 16; now < 2100; now += 16) verdict = fast.push(16, now);
    expect(verdict).toBe("ok");

    const slow = createFrameBudget();
    let slowVerdict = slow.push(120, 0);
    expect(slowVerdict).toBe("measuring");
    for (let now = 120; now < 2200; now += 120) slowVerdict = slow.push(120, now);
    expect(slowVerdict).toBe("too-slow");
    expect(slow.push(10, 5000)).toBe("too-slow");
  });
});
