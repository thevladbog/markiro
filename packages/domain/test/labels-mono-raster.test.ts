import fixture from "./fixtures/mono-raster-v1.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";

function vector(): Uint8Array {
  // Independently specified 10 mm square at 203 dpi, one black pixel at (1, 1).
  const bytes = new Uint8Array(864);
  bytes.set([77, 75, 82, 77, 78, 79, 49, 0]);
  const v = new DataView(bytes.buffer);
  v.setUint32(8, 203, true);
  v.setUint32(12, 80, true);
  v.setUint32(16, 80, true);
  v.setUint32(20, 10, true);
  v.setFloat64(24, 10, true);
  v.setFloat64(32, 10, true);
  v.setUint32(40, 800, true);
  v.setUint32(48, 1, true);
  v.setUint32(52, 1, true);
  v.setUint32(56, 2, true);
  v.setUint32(60, 2, true);
  bytes[74] = 0x40;
  return bytes;
}

describe("mono-raster-v1", () => {
  it("exports the validated portable artifact codec", () => {
    expect(domain).toHaveProperty("decodeMonoRaster", expect.any(Function));
    expect(domain).toHaveProperty("encodeMonoRaster", expect.any(Function));
  });
  it("reads an independent vector without changing pixels or geometry", () => {
    expect(Uint8Array.from(atob(fixture.base64), (c) => c.charCodeAt(0))).toEqual(vector());
    const page = domain.decodeMonoRaster(vector());
    expect(page).toMatchObject({
      format: "mono-raster-v1",
      widthMm: 10,
      heightMm: 10,
      dpi: 203,
      widthDots: 80,
      heightDots: 80,
      stride: 10,
      requiredBounds: { left: 1, top: 1, right: 2, bottom: 2 },
    });
    expect(page.pixels[10]).toBe(0x40);
    expect(domain.encodeMonoRaster(page)).toEqual(vector());
  });
  it.each([7, 63, 863, 865])("rejects an incorrect length %i", (size) => {
    const bytes = new Uint8Array(size);
    bytes.set(vector().subarray(0, size));
    expect(() => domain.decodeMonoRaster(bytes)).toThrow();
  });
  it.each([
    [8, 600],
    [12, 0xffffffff],
    [20, 9],
    [40, 0xffffffff],
    [44, 1],
    [56, 81],
  ])("rejects malformed integer metadata %i", (offset, value) => {
    const bytes = vector();
    new DataView(bytes.buffer).setUint32(offset, value, true);
    expect(() => domain.decodeMonoRaster(bytes)).toThrow();
  });
  it.each([NaN, Infinity, 0, 301, 10.2])("rejects invalid or inconsistent geometry %s", (width) => {
    const bytes = vector();
    new DataView(bytes.buffer).setFloat64(24, width, true);
    expect(() => domain.decodeMonoRaster(bytes)).toThrow();
  });
  it("rejects ink outside the declared required area", () => {
    const bytes = vector();
    bytes[64] = 0x80;
    expect(() => domain.decodeMonoRaster(bytes)).toThrow();
  });
  it("includes whitespace needed by barcode quiet zones in the digest", () => {
    const page = domain.decodeMonoRaster(vector());
    const expanded = { ...page, requiredBounds: { left: 0, top: 0, right: 3, bottom: 3 } };
    expect(domain.productLabelBytesDigest(domain.encodeMonoRaster(expanded))).not.toBe(
      domain.productLabelBytesDigest(vector()),
    );
  });
});
