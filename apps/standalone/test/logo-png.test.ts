import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { MonoBitmap } from "@markiro/domain";

import { bitmapPng, bitmapPngDataUrl } from "../src/labels/logo-png.js";

/** A 10 x 2 logo: row 0 all ink, row 1 the first dot only. */
const BITMAP: MonoBitmap = {
  width: 10,
  height: 2,
  stride: 2,
  pixels: Uint8Array.from([0xff, 0xc0, 0x80, 0x00]),
};

describe("a logo as a PNG for the printed forms", () => {
  it("is a valid 1-bit grayscale PNG of the bitmap's size", () => {
    const png = bitmapPng(BITMAP);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe("IHDR");
    expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([10, 2, 1, 0]);
    // The rows come back through a real zlib: ink is black (0), the ground and the padding white.
    const idat = png.subarray(8 + 25);
    const length = new DataView(idat.buffer, idat.byteOffset).getUint32(0);
    const raw = inflateSync(idat.subarray(8, 8 + length));
    expect([...raw]).toEqual([0, 0x00, 0x3f, 0, 0x7f, 0xff]);
  });

  it("is a data URL the printed forms accept", () => {
    expect(bitmapPngDataUrl(BITMAP)).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  });

  it("splits a large logo into stored blocks that inflate back whole", () => {
    const width = 1024;
    const height = 512;
    const stride = width / 8;
    const pixels = new Uint8Array(stride * height).fill(0xaa);
    const png = bitmapPng({ width, height, stride, pixels });
    const idat = png.subarray(8 + 25);
    const length = new DataView(idat.buffer, idat.byteOffset).getUint32(0);
    const raw = inflateSync(idat.subarray(8, 8 + length));
    expect(raw.length).toBe(height * (stride + 1));
    expect(raw[1]).toBe(0x55);
  });
});
