import { describe, expect, it } from "vitest";
import {
  buildGfaCommand,
  rasterAlignOffsetDots,
  type RasterResult,
} from "../src/labels/raster-types.js";
import { bitmapToTsplBytes, bitmapToZplHex, convertToMonochrome } from "../src/labels/raster.js";

/** Builds a solid-color RGBA buffer (one pixel repeated `width*height` times). */
function solidRgba(
  width: number,
  height: number,
  [r, g, b, a]: [number, number, number, number],
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  }
  return rgba;
}

describe("convertToMonochrome", () => {
  // gray = 0.299*255 + 0.587*0 + 0.114*0 = 76.245 -- NOT > 127 -- black (1).
  it("converts pure red (255,0,0) to black (1)", () => {
    const rgba = solidRgba(1, 1, [255, 0, 0, 255]);
    expect(convertToMonochrome(rgba, 1, 1)).toEqual(new Uint8Array([1]));
  });

  // gray = 255*(0.299+0.587+0.114) = 255 -- > 127 -- white (0).
  it("converts pure white (255,255,255) to white (0)", () => {
    const rgba = solidRgba(1, 1, [255, 255, 255, 255]);
    expect(convertToMonochrome(rgba, 1, 1)).toEqual(new Uint8Array([0]));
  });

  // Threshold boundary: gray=128 -- 128 > 127 -- white (0).
  it("converts mid-gray 128 to white (0) at the threshold boundary", () => {
    const rgba = solidRgba(1, 1, [128, 128, 128, 255]);
    expect(convertToMonochrome(rgba, 1, 1)).toEqual(new Uint8Array([0]));
  });

  // Threshold boundary: gray=127 -- 127 is NOT > 127 -- black (1).
  it("converts gray 127 to black (1) at the threshold boundary", () => {
    const rgba = solidRgba(1, 1, [127, 127, 127, 255]);
    expect(convertToMonochrome(rgba, 1, 1)).toEqual(new Uint8Array([1]));
  });

  it("preserves left-to-right pixel order across a multi-pixel row", () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]); // white, then black
    expect(convertToMonochrome(rgba, 2, 1)).toEqual(new Uint8Array([0, 1]));
  });
});

describe("bitmapToZplHex", () => {
  it("packs an 8x2 all-black bitmap to hex FFFF (2 bytes, 1 byte/row)", () => {
    const mono = new Uint8Array(8 * 2).fill(1);
    expect(bitmapToZplHex(mono, 8, 2)).toEqual({ hex: "FFFF", totalBytes: 2, bytesPerRow: 1 });
  });

  it("packs a 10x1 all-black bitmap to hex FFC0 with white (0) padding bits", () => {
    // bytesPerRow = ceil(10/8) = 2. Byte0 = pixels 0-7, all black -> 0xFF.
    // Byte1 = pixels 8-15, but only 8,9 exist (width=10); both black -> bits
    // 7,6 set (0x80|0x40=0xC0), padding bits 10-15 stay 0 (white) -> 0xC0.
    const mono = new Uint8Array(10).fill(1);
    expect(bitmapToZplHex(mono, 10, 1)).toEqual({ hex: "FFC0", totalBytes: 2, bytesPerRow: 2 });
  });

  it("packs an 8x2 checkerboard (row0 starts black, row1 starts white) to AA55", () => {
    // Row0: B,W,B,W,B,W,B,W -> bits 1,0,1,0,1,0,1,0 (MSB-first) -> 0xAA.
    // Row1: W,B,W,B,W,B,W,B -> bits 0,1,0,1,0,1,0,1 (MSB-first) -> 0x55.
    // prettier-ignore
    const mono = new Uint8Array([
      1, 0, 1, 0, 1, 0, 1, 0,
      0, 1, 0, 1, 0, 1, 0, 1,
    ]);
    expect(bitmapToZplHex(mono, 8, 2)).toEqual({ hex: "AA55", totalBytes: 2, bytesPerRow: 1 });
  });

  it("packs an all-white bitmap to an all-zero hex byte", () => {
    const mono = new Uint8Array(8).fill(0);
    expect(bitmapToZplHex(mono, 8, 1)).toEqual({ hex: "00", totalBytes: 1, bytesPerRow: 1 });
  });

  describe("RasterResult assembly consistency", () => {
    it("carries width/height alongside bitmapToZplHex's byte math into a valid RasterResult", () => {
      // Non-multiple-of-8 width (10) exercises the byte-padding math again
      // at the RasterResult-assembly boundary, not just bitmapToZplHex's own
      // return.
      const mono = new Uint8Array(10).fill(1);
      const packed = bitmapToZplHex(mono, 10, 1);
      const result: RasterResult = { ...packed, width: 10, height: 1 };

      expect(result).toEqual({
        hex: "FFC0",
        totalBytes: 2,
        bytesPerRow: 2,
        width: 10,
        height: 1,
      });
      // buildGfaCommand only reads hex/totalBytes/bytesPerRow -- width/height
      // are carried for callers but never appear in the emitted command.
      expect(buildGfaCommand(result)).toBe("^GFA,2,2,2,FFC0");
    });
  });
});

describe("rasterAlignOffsetDots", () => {
  it("returns 0 when maxWidthDots is undefined, regardless of align", () => {
    expect(rasterAlignOffsetDots("center", undefined, 10)).toBe(0);
    expect(rasterAlignOffsetDots("right", undefined, 10)).toBe(0);
  });

  it("returns 0 for align left even when maxWidthDots is set", () => {
    expect(rasterAlignOffsetDots("left", 100, 20)).toBe(0);
  });

  it("returns 0 for align undefined even when maxWidthDots is set", () => {
    expect(rasterAlignOffsetDots(undefined, 100, 20)).toBe(0);
  });

  it("centers exactly for an even remainder", () => {
    // (100 - 20) / 2 = 40, no rounding needed.
    expect(rasterAlignOffsetDots("center", 100, 20)).toBe(40);
  });

  it("rounds an odd remainder for align center", () => {
    // (101 - 20) / 2 = 40.5 -> Math.round -> 41.
    expect(rasterAlignOffsetDots("center", 101, 20)).toBe(41);
  });

  it("aligns flush to the trailing edge for align right", () => {
    // 100 - 20 = 80.
    expect(rasterAlignOffsetDots("right", 100, 20)).toBe(80);
  });

  it("clamps to 0 for align center when the raster is wider than maxWidthDots", () => {
    // (10 - 20) / 2 = -5 -> clamped to 0.
    expect(rasterAlignOffsetDots("center", 10, 20)).toBe(0);
  });

  it("clamps to 0 for align right when the raster is wider than maxWidthDots", () => {
    // 10 - 20 = -10 -> clamped to 0.
    expect(rasterAlignOffsetDots("right", 10, 20)).toBe(0);
  });
});

describe("bitmapToTsplBytes", () => {
  it("inverts an 8x1 all-black bitmap (ZPL hex FF) to a single raw 0x00 byte", () => {
    const mono = new Uint8Array(8).fill(1);
    const result = bitmapToTsplBytes(mono, 8, 1);
    expect(result.widthBytes).toBe(1);
    expect(result.hexBytes.length).toBe(1);
    expect(result.hexBytes.charCodeAt(0)).toBe(0x00);
  });

  it("inverts an 8x1 all-white bitmap (ZPL hex 00) to a single raw 0xFF byte", () => {
    const mono = new Uint8Array(8).fill(0);
    const result = bitmapToTsplBytes(mono, 8, 1);
    expect(result.widthBytes).toBe(1);
    expect(result.hexBytes.charCodeAt(0)).toBe(0xff);
  });

  it("inverts an 8x2 checkerboard (ZPL hex AA55) byte-for-byte via XOR 0xFF", () => {
    // prettier-ignore
    const mono = new Uint8Array([
      1, 0, 1, 0, 1, 0, 1, 0,
      0, 1, 0, 1, 0, 1, 0, 1,
    ]);
    const result = bitmapToTsplBytes(mono, 8, 2);
    expect(result.widthBytes).toBe(1);
    expect(result.hexBytes.charCodeAt(0)).toBe(0x55); // 0xAA ^ 0xFF
    expect(result.hexBytes.charCodeAt(1)).toBe(0xaa); // 0x55 ^ 0xFF
  });
});
