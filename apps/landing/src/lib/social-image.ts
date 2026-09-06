import { readFileSync } from "node:fs";

export interface ImageDimensions {
  width: number;
  height: number;
}

const PUBLIC_ROOT = new URL("../../public/", import.meta.url);
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const cache = new Map<string, ImageDimensions | null>();

/**
 * Reads the pixel size from a baseline or progressive JPEG by walking its marker
 * segments until the first start-of-frame marker. Returns null for anything that
 * is not a well-formed JPEG so callers can omit dimension metadata instead of
 * publishing a wrong value.
 */
export function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === undefined) return null;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const lengthHigh = bytes[offset + 2];
    const lengthLow = bytes[offset + 3];
    if (lengthHigh === undefined || lengthLow === undefined) return null;
    const length = (lengthHigh << 8) | lengthLow;
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return null;
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * Resolves a site-relative public path such as `/og-markiro.jpg` against the
 * landing `public/` directory at build time.
 */
export function socialImageDimensions(publicPath: string): ImageDimensions | null {
  const cached = cache.get(publicPath);
  if (cached !== undefined) return cached;
  let dimensions: ImageDimensions | null = null;
  if (/\.jpe?g$/i.test(publicPath)) {
    try {
      dimensions = readJpegDimensions(
        readFileSync(new URL(publicPath.replace(/^\//, ""), PUBLIC_ROOT)),
      );
    } catch {
      dimensions = null;
    }
  }
  cache.set(publicPath, dimensions);
  return dimensions;
}
