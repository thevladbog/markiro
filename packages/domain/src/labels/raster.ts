/**
 * Pure raster primitives — Idento-parity port (Plan 04 Task 4).
 *
 * Ports, EXACTLY, the pixel-level conversion math from Idento's
 * `panel/src/features/badge/zpl/zplImage.ts` (`convertToMonochrome`,
 * `bitmapToZPLHex`): grayscale via 0.299R+0.587G+0.114B, hard threshold at
 * 127 with no dithering, and 8px/byte MSB-first uppercase-hex packing with
 * byte-padded rows. This module is zero-dependency and DOM-free per the
 * plan's Global Constraints — it only ever consumes already-rasterized
 * pixel data (`Uint8ClampedArray`/`Uint8Array` + `width`/`height`); the
 * browser `<canvas>` rasterizer that PRODUCES that pixel data lives in
 * `apps/admin` (Task 5).
 *
 * PACKAGE BOUNDARY (see `raster-types.ts`'s own module doc comment for the
 * full rationale): `RasterResult`/`RasterizeTextFn` (shared data shapes) and
 * `buildGfaCommand`/`buildBitmapCommand` (printer-command-string assembly)
 * live in `./raster-types.ts`, not here — this module only produces the
 * pixel-packed pieces (`hex`/`totalBytes`/`bytesPerRow` for ZPL,
 * `hexBytes`/`widthBytes` for TSPL) that a caller assembles into a full
 * `RasterResult` (see `bitmapToZplHex`'s doc comment) or hands to
 * `buildBitmapCommand`. `bitmapToTsplBytes` reuses `raster-types.ts`'s
 * `invertHexToTsplBytes` for the ZPL<->TSPL polarity flip rather than
 * re-deriving it, so `raster-types.ts` remains the single source of truth
 * for that polarity.
 */
import { invertHexToTsplBytes } from "./raster-types.js";

/**
 * Convert RGBA pixel data to a monochrome bit array (1 = black, 0 = white).
 * Exact port of Idento's `convertToMonochrome`
 * (`panel/src/features/badge/zpl/zplImage.ts:75-93`), which there consumed a
 * canvas `ImageData` object; here the same `data`/`width`/`height` fields
 * are passed in directly so this runs without a canvas (e.g. under Vitest's
 * default jsdom-free node environment).
 *
 * Alpha (`rgba[i+3]`) is read as part of each pixel quad's stride but is NOT
 * used in the grayscale/threshold math, matching Idento exactly — a caller
 * with non-opaque source pixels must pre-composite onto an opaque
 * background before calling this.
 */
export function convertToMonochrome(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const monochromeData = new Uint8Array(width * height);

  for (let i = 0; i < rgba.length; i += 4) {
    // `?? 0` satisfies `noUncheckedIndexedAccess` for an always-in-bounds
    // read (the loop bound is `rgba.length`, so `i`/`i+1`/`i+2` are always
    // valid indices into a well-formed RGBA buffer); it never changes
    // behavior for real input.
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;

    // Grayscale (Idento zplImage.ts:85).
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;

    // Threshold: > 127 = white (0), <= 127 = black (1). No dithering
    // (Idento zplImage.ts:87-89).
    const pixelIndex = i / 4;
    monochromeData[pixelIndex] = gray > 127 ? 0 : 1;
  }

  return monochromeData;
}

/**
 * The pixel-packed pieces of a `RasterResult` (see `raster-types.ts`) that
 * `bitmapToZplHex` alone can compute from a monochrome bitmap. Deliberately
 * excludes `width`/`height`: the caller already has both on hand (it passed
 * them in as parameters) and merges them in — `{ ...bitmapToZplHex(mono, w,
 * h), width: w, height: h }` — to assemble a full `RasterResult`, so this
 * type never needs to re-carry values the caller already owns.
 */
export interface ZplHexPacking {
  hex: string;
  totalBytes: number;
  bytesPerRow: number;
}

/**
 * Pack a monochrome bit array into ZPL's uncompressed `^GFA` hex payload: 8
 * pixels per byte, MSB-first, uppercase hex, byte-padded rows (padding bits
 * are 0 = white, matching ZPL's white/0 convention — the bit is only ever
 * set to 1 for an in-bounds black pixel; out-of-bounds padding bits are left
 * at the byte's initial 0). Exact port of Idento's `bitmapToZPLHex`
 * (`panel/src/features/badge/zpl/zplImage.ts:98-125`) plus its byte-count
 * math (`totalBytes = bytesPerRow * height`, matching Idento's
 * uncompressed-only path where both `^GFA` byte-count params are equal).
 * Row bytes are concatenated directly with no separators, matching `^GFA`'s
 * flat hex-string data parameter.
 */
export function bitmapToZplHex(bitmap: Uint8Array, width: number, height: number): ZplHexPacking {
  const bytesPerRow = Math.ceil(width / 8);
  const hexData: string[] = [];

  for (let y = 0; y < height; y++) {
    let rowBytes = "";
    for (let x = 0; x < bytesPerRow; x++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const pixelX = x * 8 + bit;
        if (pixelX < width) {
          const pixelIndex = y * width + pixelX;
          if (bitmap[pixelIndex] === 1) {
            byte |= 1 << (7 - bit);
          }
        }
      }
      rowBytes += byte.toString(16).toUpperCase().padStart(2, "0");
    }
    hexData.push(rowBytes);
  }

  const hex = hexData.join("");
  const totalBytes = bytesPerRow * height;
  return { hex, totalBytes, bytesPerRow };
}

/** The raw-byte pieces `bitmapToTsplBytes` produces for a TSPL `BITMAP` command. */
export interface TsplBytesPacking {
  /**
   * The TSPL-polarity bitmap bytes as a Latin-1 string — one raw byte per
   * character (this package's binary-carrier convention; see `tspl.ts`'s
   * module doc comment for the full transport requirement). Named to mirror
   * `invertHexToTsplBytes`'s own hex-in/bytes-out convention, NOT because
   * this is an ASCII-hex string.
   */
  hexBytes: string;
  /** Row byte count — TSPL `BITMAP`'s `width` (in bytes) parameter. */
  widthBytes: number;
}

/**
 * Pack a monochrome bit array into TSPL `BITMAP`-ready raw binary bytes.
 * Builds the ZPL-polarity hex payload via `bitmapToZplHex` and inverts every
 * bit through `raster-types.ts`'s `invertHexToTsplBytes` — the single source
 * of truth for the ZPL<->TSPL polarity flip (bit 1 = black in ZPL, bit 0 =
 * black in TSPL; see that function's doc comment for the sourcing) — rather
 * than re-deriving the inversion here.
 */
export function bitmapToTsplBytes(
  bitmap: Uint8Array,
  width: number,
  height: number,
): TsplBytesPacking {
  const { hex, bytesPerRow } = bitmapToZplHex(bitmap, width, height);
  return { hexBytes: invertHexToTsplBytes(hex), widthBytes: bytesPerRow };
}
