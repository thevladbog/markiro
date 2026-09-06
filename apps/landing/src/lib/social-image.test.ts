import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readJpegDimensions, socialImageDimensions } from "./social-image";

const publicRoot = new URL("../../public/", import.meta.url);

describe("social image dimensions", () => {
  it("reads the real pixel size of every published Open Graph image", () => {
    expect(readJpegDimensions(readFileSync(new URL("og-markiro.jpg", publicRoot)))).toEqual({
      width: 1376,
      height: 768,
    });
    expect(
      readJpegDimensions(readFileSync(new URL("og-beer-case-aggregation.jpg", publicRoot))),
    ).toEqual({ width: 1200, height: 675 });
    expect(
      readJpegDimensions(readFileSync(new URL("og-beer-marking-cost.jpg", publicRoot))),
    ).toEqual({ width: 1200, height: 630 });
  });

  it("returns null for bytes that are not a JPEG", () => {
    expect(readJpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(readJpegDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it("resolves a site-relative social image path against the public directory", () => {
    expect(socialImageDimensions("/og-offline-beer-marking.jpg")).toEqual({
      width: 1200,
      height: 630,
    });
    expect(socialImageDimensions("/favicon.svg")).toBeNull();
    expect(socialImageDimensions("/does-not-exist.jpg")).toBeNull();
  });
});
