import { describe, expect, it } from "vitest";
import { mapFontFamily, RasterUnavailableError, rasterizeText } from "../src/lib/rasterizer.js";

describe("mapFontFamily", () => {
  it("maps the generic sans keyword to the bundled family", () => {
    expect(mapFontFamily("sans-serif")).toBe("IBM Plex Sans, sans-serif");
  });

  it("maps the generic monospace keyword to the bundled family", () => {
    expect(mapFontFamily("monospace")).toBe("IBM Plex Mono, monospace");
  });

  it("passes an already-bundled family through unchanged", () => {
    expect(mapFontFamily("IBM Plex Sans")).toBe("IBM Plex Sans");
  });
});

describe("rasterizeText under jsdom", () => {
  it("rejects with RasterUnavailableError when no canvas backend exists", async () => {
    await expect(
      rasterizeText("Привет", { fontFamily: "sans-serif", fontSizePx: 24, bold: false }),
    ).rejects.toBeInstanceOf(RasterUnavailableError);
  });
});
