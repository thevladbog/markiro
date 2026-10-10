import { DomainError } from "../errors.js";
import { mmToDots } from "./model.js";
import { MONO_RASTER_MAX_BYTES, MONO_RASTER_HEADER_BYTES, type MonoRaster } from "./mono-raster.js";
import type { RasterResult } from "./raster-types.js";

export interface MonoBitmap {
  width: number;
  height: number;
  stride: number;
  pixels: Uint8Array;
}
export function validateMonoBitmap(bitmap: MonoBitmap): void {
  const { width, height, stride, pixels } = bitmap;
  if (
    ![width, height, stride].every(Number.isSafeInteger) ||
    width < 1 ||
    height < 1 ||
    width > 3508 ||
    height > 3508 ||
    stride !== Math.ceil(width / 8) ||
    !(pixels instanceof Uint8Array) ||
    pixels.length !== stride * height ||
    pixels.length > MONO_RASTER_MAX_BYTES
  )
    throw new DomainError("LABEL_SHEET_RASTER", "Invalid monochrome bitmap");
  const unused = (8 - (width % 8)) % 8;
  if (unused)
    for (let y = 0; y < height; y++) {
      if ((pixels[(y + 1) * stride - 1] ?? 0) & ((1 << unused) - 1))
        throw new DomainError("LABEL_SHEET_RASTER", "Nonzero row padding");
    }
}
export function bitmapFromText(raster: RasterResult): MonoBitmap {
  const { width, height, bytesPerRow: stride, hex } = raster;
  if (
    !Number.isSafeInteger(stride * height) ||
    stride * height > MONO_RASTER_MAX_BYTES ||
    hex.length !== stride * height * 2 ||
    raster.totalBytes !== stride * height ||
    !/^[0-9a-f]+$/i.test(hex)
  )
    throw new DomainError("LABEL_SHEET_RASTER", "Invalid text raster");
  const pixels = new Uint8Array(stride * height);
  for (let i = 0; i < pixels.length; i++)
    pixels[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const result = { width, height, stride, pixels };
  validateMonoBitmap(result);
  return result;
}
export function createSheetPage(widthMm: number, heightMm: number): MonoRaster {
  const widthDots = mmToDots(widthMm, 300),
    heightDots = mmToDots(heightMm, 300),
    stride = Math.ceil(widthDots / 8);
  if (
    ![widthDots, heightDots].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 3508) ||
    stride * heightDots + MONO_RASTER_HEADER_BYTES > MONO_RASTER_MAX_BYTES
  )
    throw new DomainError("LABEL_SHEET_BOUNDS", "Sheet raster exceeds supported dimensions");
  return {
    format: "mono-raster-v1",
    widthMm,
    heightMm,
    dpi: 300,
    widthDots,
    heightDots,
    stride,
    pixels: new Uint8Array(stride * heightDots),
    requiredBounds: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}
export function bitmapPixel(bitmap: MonoBitmap, x: number, y: number): boolean {
  return Boolean((bitmap.pixels[y * bitmap.stride + (x >> 3)] ?? 0) & (0x80 >> (x % 8)));
}
export function pasteMonoBitmap(page: MonoRaster, bitmap: MonoBitmap, x: number, y: number): void {
  validateMonoBitmap(bitmap);
  if (
    ![x, y].every(Number.isSafeInteger) ||
    x < 0 ||
    y < 0 ||
    x + bitmap.width > page.widthDots ||
    y + bitmap.height > page.heightDots
  )
    throw new DomainError("LABEL_SHEET_BOUNDS", "Bitmap exceeds the sheet");
  const b = page.requiredBounds;
  page.requiredBounds =
    b.right === 0
      ? { left: x, top: y, right: x + bitmap.width, bottom: y + bitmap.height }
      : {
          left: Math.min(b.left, x),
          top: Math.min(b.top, y),
          right: Math.max(b.right, x + bitmap.width),
          bottom: Math.max(b.bottom, y + bitmap.height),
        };
  for (let by = 0; by < bitmap.height; by++)
    for (let bx = 0; bx < bitmap.width; bx++) {
      if (bitmapPixel(bitmap, bx, by)) {
        const px = x + bx,
          py = y + by,
          index = py * page.stride + (px >> 3);
        page.pixels[index] = (page.pixels[index] ?? 0) | (0x80 >> (px % 8));
      }
    }
}
export function scaleMonoBitmap(bitmap: MonoBitmap, width: number, height: number): MonoBitmap {
  validateMonoBitmap(bitmap);
  if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 3508))
    throw new DomainError("LABEL_SHEET_BOUNDS", "Invalid logo dimensions");
  const stride = Math.ceil(width / 8),
    result = { width, height, stride, pixels: new Uint8Array(stride * height) };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (
        bitmapPixel(
          bitmap,
          Math.floor((x * bitmap.width) / width),
          Math.floor((y * bitmap.height) / height),
        )
      ) {
        const index = y * stride + (x >> 3);
        result.pixels[index] = (result.pixels[index] ?? 0) | (0x80 >> (x % 8));
      }
    }
  return result;
}
export function rectangleBitmap(
  width: number,
  height: number,
  thickness: number,
  filled = false,
): MonoBitmap {
  const stride = Math.ceil(width / 8),
    result = { width, height, stride, pixels: new Uint8Array(stride * height) };
  validateMonoBitmap(result);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (
        filled ||
        x < thickness ||
        y < thickness ||
        x >= width - thickness ||
        y >= height - thickness
      ) {
        const index = y * stride + (x >> 3);
        result.pixels[index] = (result.pixels[index] ?? 0) | (0x80 >> (x % 8));
      }
    }
  return result;
}
