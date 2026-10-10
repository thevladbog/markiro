import { mmToDots, type PrinterDpi } from "./model.js";

export const MONO_RASTER_MAX_BYTES = 2 * 1024 * 1024;
export const MONO_RASTER_HEADER_BYTES = 64;
const MAGIC = [77, 75, 82, 77, 78, 79, 49, 0] as const;
export interface MonoRasterBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface MonoRaster {
  format: "mono-raster-v1";
  widthMm: number;
  heightMm: number;
  dpi: PrinterDpi;
  widthDots: number;
  heightDots: number;
  stride: number;
  requiredBounds: MonoRasterBounds;
  /** Top-down, MSB-first, 1=black; unused row bits must be zero. */
  pixels: Uint8Array;
}
function invalid(): never {
  throw new RangeError("Invalid mono-raster-v1 artifact");
}
function geometry(page: Omit<MonoRaster, "pixels">): number {
  const { widthMm, heightMm, widthDots, heightDots, stride, dpi, requiredBounds: b } = page;
  if (
    page.format !== "mono-raster-v1" ||
    (dpi !== 203 && dpi !== 300) ||
    ![widthMm, heightMm].every((n) => Number.isFinite(n) && n >= 10 && n <= 300) ||
    widthDots !== mmToDots(widthMm, dpi) ||
    heightDots !== mmToDots(heightMm, dpi) ||
    stride !== Math.ceil(widthDots / 8) ||
    ![b.left, b.top, b.right, b.bottom].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    b.left > b.right ||
    b.top > b.bottom ||
    b.right > widthDots ||
    b.bottom > heightDots
  )
    invalid();
  const length = stride * heightDots;
  if (!Number.isSafeInteger(length) || length + MONO_RASTER_HEADER_BYTES > MONO_RASTER_MAX_BYTES)
    invalid();
  return length;
}
function validatePixels(page: MonoRaster): void {
  if (!(page.pixels instanceof Uint8Array) || page.pixels.length !== geometry(page)) invalid();
  const { widthDots, heightDots, stride, requiredBounds: b, pixels } = page;
  for (let y = 0; y < heightDots; y++) {
    for (let byteX = 0; byteX < stride; byteX++) {
      const value = pixels[y * stride + byteX] ?? 0;
      if (!value) continue;
      for (let bit = 0; bit < 8; bit++) {
        if (!(value & (0x80 >> bit))) continue;
        const x = byteX * 8 + bit;
        if (x >= widthDots || x < b.left || x >= b.right || y < b.top || y >= b.bottom) invalid();
      }
    }
  }
}
/** The entire header, including required quiet zones, is part of the saved digest. */
export function encodeMonoRaster(page: MonoRaster): Uint8Array {
  validatePixels(page);
  const bytes = new Uint8Array(MONO_RASTER_HEADER_BYTES + page.pixels.length);
  bytes.set(MAGIC);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, page.dpi, true);
  view.setUint32(12, page.widthDots, true);
  view.setUint32(16, page.heightDots, true);
  view.setUint32(20, page.stride, true);
  view.setFloat64(24, page.widthMm, true);
  view.setFloat64(32, page.heightMm, true);
  view.setUint32(40, page.pixels.length, true);
  const b = page.requiredBounds;
  view.setUint32(48, b.left, true);
  view.setUint32(52, b.top, true);
  view.setUint32(56, b.right, true);
  view.setUint32(60, b.bottom, true);
  bytes.set(page.pixels, MONO_RASTER_HEADER_BYTES);
  return bytes;
}
export function decodeMonoRaster(bytes: Uint8Array): MonoRaster {
  if (
    bytes.length < MONO_RASTER_HEADER_BYTES ||
    bytes.length > MONO_RASTER_MAX_BYTES ||
    !MAGIC.every((v, i) => bytes[i] === v)
  )
    invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dpi = view.getUint32(8, true);
  if ((dpi !== 203 && dpi !== 300) || view.getUint32(44, true) !== 0) invalid();
  const metadata: Omit<MonoRaster, "pixels"> = {
    format: "mono-raster-v1" as const,
    dpi,
    widthDots: view.getUint32(12, true),
    heightDots: view.getUint32(16, true),
    stride: view.getUint32(20, true),
    widthMm: view.getFloat64(24, true),
    heightMm: view.getFloat64(32, true),
    requiredBounds: {
      left: view.getUint32(48, true),
      top: view.getUint32(52, true),
      right: view.getUint32(56, true),
      bottom: view.getUint32(60, true),
    },
  };
  const length = geometry(metadata);
  if (view.getUint32(40, true) !== length || bytes.length !== MONO_RASTER_HEADER_BYTES + length)
    invalid();
  const page: MonoRaster = { ...metadata, pixels: bytes.subarray(MONO_RASTER_HEADER_BYTES) };
  validatePixels(page);
  return page;
}
