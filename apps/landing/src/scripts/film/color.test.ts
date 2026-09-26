import { describe, expect, it } from "vitest";

import { formatHex, mixHex, mixStops, parseHex, relativeLuminance } from "./color";

describe("film colour helpers", () => {
  it("round-trips hex colours", () => {
    expect(formatHex(parseHex("#3DDC7A"))).toBe("#3ddc7a");
  });

  it("rejects anything that is not #rrggbb", () => {
    expect(() => parseHex("green")).toThrow("Expected a #rrggbb colour");
  });

  it("mixes in linear light", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#bcbcbc");
    expect(mixHex("#000000", "#ffffff", 7)).toBe("#ffffff");
  });

  it("walks colour stops", () => {
    const stops = [
      [0, "#fafaf8"],
      [0.5, "#6b6461"],
      [1, "#131216"],
    ] as const;
    expect(mixStops(stops, -1)).toBe("#fafaf8");
    expect(mixStops(stops, 0.5)).toBe("#6b6461");
    expect(mixStops(stops, 2)).toBe("#131216");
  });

  it("measures relative luminance", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1);
    expect(relativeLuminance("#000000")).toBeCloseTo(0);
  });
});
