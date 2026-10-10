import type { RasterizeTextFn } from "@markiro/domain";

/** A rasterizer that draws every text as the same 8 x 2 bitmap: jsdom has no canvas. */
export const fakeRaster: RasterizeTextFn = async () => ({
  hex: "FF00",
  totalBytes: 2,
  bytesPerRow: 1,
  width: 8,
  height: 2,
});
