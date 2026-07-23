/**
 * Plan 04 Task 10: label editor chrome -- PreviewPane's "what you see is
 * what prints" raster compositing.
 *
 * `renderer.ts`'s shared `draw()` paints `text`/`field` elements with a
 * plain `ctx.fillText` in the browser's default `sans-serif` font -- fine
 * for the editor canvas and library thumbnails (Task 8/9's scope), but NOT
 * what actually gets printed once an element's resolved text needs
 * rasterization (`@markiro/domain`'s `needsImageRendering` -- Cyrillic,
 * CJK, etc.): `generateZpl`/`generateTspl` replace that text with a
 * rasterized monochrome bitmap (`RasterizeTextFn`, produced by
 * `labels/rasterizer.ts` in a real browser) baked into the print document
 * itself. `PreviewPane.tsx` composites that SAME bitmap on top of the
 * schematic canvas for exactly those elements, so the preview shows the
 * REAL printed pixels, not a font-substitute approximation.
 *
 * `decodeRasterToImageData` is split out from the actual `<canvas>`
 * compositing (`compositeRasterOntoCanvas`, in `PreviewPane.tsx` itself)
 * specifically so the BIT-UNPACKING logic -- the part with real room for an
 * off-by-one -- is unit-testable without a real 2D canvas context (jsdom has
 * none; see `renderer.ts`'s identical constraint).
 */
import type { RasterResult } from "@markiro/domain";

/** One decoded pixel channel value: 0 (black ink) or 255 (white/blank). */
const BLACK = 0;
const WHITE = 255;
const OPAQUE_ALPHA = 255;

/**
 * Unpacks a `RasterResult`'s ASCII-hex, MSB-first, byte-padded-per-row
 * bitmap (`raster-types.ts`'s `RasterResult.hex` -- ZPL polarity: bit 1 =
 * black/printed, bit 0 = white/blank, exactly `bitmapToZplHex`'s own
 * documented format, which every `RasterizeTextFn` implementation --
 * including `apps/admin/src/labels/rasterizer.ts`'s real one -- returns)
 * into a flat RGBA byte array, `raster.width * raster.height * 4` bytes,
 * row-major, ready to hand to `ImageData`'s constructor or
 * `CanvasRenderingContext2D.putImageData`.
 *
 * Deliberately returns a plain `Uint8ClampedArray` rather than a real
 * `ImageData` object: `ImageData`'s constructor itself needs a real
 * browser/canvas polyfill environment to construct correctly in some
 * runtimes, whereas this array is plain data this function can build (and a
 * test can assert against byte-for-byte) with zero DOM dependency.
 */
export function decodeRasterToRgba(raster: RasterResult): Uint8ClampedArray<ArrayBuffer> {
  const bytes: number[] = [];
  for (let i = 0; i < raster.hex.length; i += 2) {
    bytes.push(parseInt(raster.hex.slice(i, i + 2), 16));
  }

  // This function's own return type is spelled out as the full generic
  // `Uint8ClampedArray<ArrayBuffer>` (see `download.ts`'s
  // `latin1ToUint8Array` doc comment for the general pattern) -- `new
  // Uint8ClampedArray(n)`'s numeric-length overload already resolves to
  // exactly that type, so no runtime cast is needed here either.
  const rgba = new Uint8ClampedArray(raster.width * raster.height * 4);
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const byteIndex = y * raster.bytesPerRow + (x >> 3);
      const bitIndex = 7 - (x % 8);
      const isBlack = ((bytes[byteIndex] ?? 0) >> bitIndex) & 1;
      const value = isBlack ? BLACK : WHITE;

      const pixelIndex = (y * raster.width + x) * 4;
      rgba[pixelIndex] = value;
      rgba[pixelIndex + 1] = value;
      rgba[pixelIndex + 2] = value;
      rgba[pixelIndex + 3] = OPAQUE_ALPHA;
    }
  }
  return rgba;
}
