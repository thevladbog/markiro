/**
 * The webview's `RasterizeTextFn` (`@markiro/domain`), a port of
 * `apps/admin/src/labels/rasterizer.ts` and `apps/station/src/lib/rasterizer.ts`
 * that must behave as they do: a template previewed in an office and printed
 * by a station has to give the same bitmap («предпросмотр = печать»), so the
 * font mapping, the wrapping and the line height do not drift. It only draws
 * the text on a `<canvas>` and reads the pixels back; the domain's DOM-free
 * `convertToMonochrome` and `bitmapToZplHex` pack them. It lives outside the
 * office because the station of this app (plan 2a) prints through it too.
 */
import {
  bitmapToZplHex,
  convertToMonochrome,
  wrapTextToWidth,
  type RasterizeTextFn,
  type RasterizeTextOptions,
} from "@markiro/domain";

/**
 * The webview gave no 2D canvas context (jsdom has none; a real webview could
 * refuse one when out of canvas memory). Typed, so a caller tells «cannot
 * rasterize here» from any other failure.
 */
export class RasterUnavailableError extends Error {
  constructor(message = "2D canvas rendering context is unavailable in this environment") {
    super(message);
    this.name = "RasterUnavailableError";
  }
}

/**
 * The largest canvas side the rasterizer draws, in dots (stage 2a spec,
 * decision 22): 4096 is 13.6 inches at 300 dpi, longer than any label, and a
 * webview may refuse a larger canvas or run out of memory on one.
 */
export const MAX_RASTER_DOTS = 4096;

/**
 * A text that would need a canvas larger than `MAX_RASTER_DOTS` on a side:
 * a font far too large for the label, or a line with no width to wrap in.
 * Typed, so a print says «cannot render» (`render_failed`) and the office's
 * preview keeps the element's own drawing.
 */
export class RasterTooLargeError extends Error {
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    super(`a ${width} x ${height} canvas exceeds ${MAX_RASTER_DOTS} dots on a side`);
    this.name = "RasterTooLargeError";
    this.width = width;
    this.height = height;
  }
}

function canvas2d(width: number, height: number): CanvasRenderingContext2D {
  // Before the canvas exists: a webview asked for a huge one may hang or crash.
  if (width > MAX_RASTER_DOTS || height > MAX_RASTER_DOTS) {
    throw new RasterTooLargeError(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new RasterUnavailableError();
  return context;
}

/**
 * The generic families the domain's generators ask for, mapped to the app's
 * bundled IBM Plex faces with the generic one kept as the fallback; a family
 * already named (the preview asks for «IBM Plex Sans») stays as it is.
 */
export function mapFontFamily(family: string): string {
  if (family === "sans-serif") return "IBM Plex Sans, sans-serif";
  if (family === "monospace") return "IBM Plex Mono, monospace";
  return family;
}

function fontShorthand(family: string, sizePx: number, bold: boolean): string {
  return `${bold ? 700 : 400} ${sizePx}px ${mapFontFamily(family)}`;
}

/**
 * Measures the text on a throwaway context, wraps it to `maxWidthPx` and
 * `maxLines` with the same measure (the emitters never clip a bitmap, so this
 * keeps a long name on the label; what still does not fit ends in «…»),
 * draws each line black on white in a box of `ceil(sizePx × 1.5)` and packs
 * the pixels. The width is clamped too: a line that fills the box exactly
 * could round one dot past it.
 */
function rasterizeTextSync(
  text: string,
  { fontFamily, fontSizePx, bold, maxWidthPx, maxLines }: RasterizeTextOptions,
) {
  const font = fontShorthand(fontFamily, fontSizePx, bold);
  const measureContext = canvas2d(1, 1);
  measureContext.font = font;
  const measure = (line: string) => measureContext.measureText(line).width;

  const bounded = maxWidthPx !== undefined && maxWidthPx > 0;
  const lines = bounded ? wrapTextToWidth(text, measure, maxWidthPx, maxLines ?? 1) : [text];
  const lineHeight = Math.ceil(fontSizePx * 1.5);
  const naturalWidth = Math.ceil(Math.max(...lines.map(measure)));
  const width = Math.max(1, bounded ? Math.min(maxWidthPx, naturalWidth) : naturalWidth);
  const height = lineHeight * lines.length;

  const context = canvas2d(width, height);
  context.font = font;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#000000";
  context.textBaseline = "middle";
  lines.forEach((line, index) => {
    context.fillText(line, 0, index * lineHeight + lineHeight / 2);
  });

  const { data } = context.getImageData(0, 0, width, height);
  const packed = bitmapToZplHex(convertToMonochrome(data, width, height), width, height);
  return { ...packed, width, height };
}

/**
 * Loads the face for the text's own script first (`document.fonts.load` with
 * the text: by default only the Latin subset loads), so the measure and the
 * drawing use IBM Plex rather than a fallback; a load that fails or a webview
 * without `document.fonts` is not fatal.
 */
export const rasterizeText: RasterizeTextFn = async (text, options) => {
  const font = fontShorthand(options.fontFamily, options.fontSizePx, options.bold);
  try {
    await document.fonts?.load(font, text);
  } catch {
    // Best effort: the canvas draws with whatever face it has.
  }
  try {
    return rasterizeTextSync(text, options);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};
