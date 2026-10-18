import type { MonoBitmap } from "@markiro/domain";

/**
 * Draws a 1-bit logo as it prints, black dots on white, at one canvas pixel
 * per dot. Only the thresholded bits are drawn: an uploaded picture is never
 * put on the page itself.
 */
export function paintBitmap(canvas: HTMLCanvasElement, bitmap: MonoBitmap): void {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (context === null) return;
  const data = new Uint8ClampedArray(bitmap.width * bitmap.height * 4).fill(255);
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      const byte = bitmap.pixels[y * bitmap.stride + (x >> 3)] ?? 0;
      if ((byte & (0x80 >> (x & 7))) === 0) continue;
      const offset = (y * bitmap.width + x) * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
    }
  }
  context.putImageData(new ImageData(data, bitmap.width, bitmap.height), 0, 0);
}

/**
 * Whether any dot of the bitmap is ink. A picture that thresholds to white
 * (a white logo on a transparent ground, a washed-out scan) would print
 * nothing, so the office refuses it instead of saving an empty logo.
 */
export function hasInk(bitmap: MonoBitmap): boolean {
  return bitmap.pixels.some((byte) => byte !== 0);
}
