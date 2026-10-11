import {
  elementBoundsMm,
  INTERIOR_MODULES,
  labelFieldDisplayValue,
  LINE_HEIGHT_EM,
  mmToDots,
  needsImageRendering,
  ptToDots,
  ptToMm,
  QUIET_ZONE_MODULES,
  rasterAlignOffsetDots,
  TOTAL_MODULES,
  wrapTextToWidth,
  type LabelBarcodeElement,
  type LabelBoxElement,
  type LabelField,
  type LabelFieldElement,
  type LabelLineElement,
  type LabelTemplateSpec,
  type LabelTextElement,
  type RasterizeTextFn,
  type RasterResult,
} from "@markiro/domain";

import type { LabelRenderOptions } from "./label-samples.js";

/**
 * The part of a 2D context a label is drawn with: a real
 * `CanvasRenderingContext2D` is one, and a test records the calls of its own.
 */
export interface LabelCanvas {
  font: string;
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  lineWidth: number;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/** A label is black ink on white stock whatever the office's theme. */
export const LABEL_BACKGROUND = "#ffffff";
const INK = "#000000";

/** The family the domain's generators ask the rasterizer for (`zpl.ts`, `tspl.ts`). */
const PRINT_FONT_FAMILY = "sans-serif";

type TextLikeElement = LabelTextElement | LabelFieldElement;

function textOf(element: TextLikeElement, data: Record<LabelField, string>): string {
  return element.kind === "text"
    ? element.text
    : labelFieldDisplayValue(element.field, data, element.textFormat);
}

/**
 * Whether the print draws an element's text as a bitmap whatever the text is:
 * an element that names its own line height or family opts into the bundled
 * fonts (the domain's `renderTextLikeElement`, #703), ASCII included.
 */
function asksForBitmap(element: TextLikeElement): boolean {
  return element.lineHeight !== undefined || element.fontFamily !== undefined;
}

/**
 * The text elements the print rasterizes with `data`: those whose text is not
 * printable ASCII only (`needsImageRendering`, Cyrillic above all), and those
 * that ask for a bitmap themselves (`asksForBitmap`).
 */
export function rasterTextElements(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
): TextLikeElement[] {
  return spec.elements.filter(
    (element): element is TextLikeElement =>
      (element.kind === "text" || element.kind === "field") &&
      (asksForBitmap(element) || needsImageRendering(textOf(element, data))),
  );
}

/**
 * Paints a bitmap's black dots (`RasterResult`: hex, rows padded to bytes,
 * the most significant bit first, 1 for ink) as one rectangle per run of a
 * row, from `(xPx, yPx)`, each dot `dotPx` wide. Dots past the bitmap's width
 * (the padding) are never painted.
 */
export function paintRaster(
  canvas: LabelCanvas,
  raster: RasterResult,
  xPx: number,
  yPx: number,
  dotPx: number,
): void {
  canvas.fillStyle = INK;
  for (let row = 0; row < raster.height; row++) {
    let runStart = -1;
    for (let column = 0; column <= raster.width; column++) {
      let ink = false;
      if (column < raster.width) {
        const offset = (row * raster.bytesPerRow + (column >> 3)) * 2;
        const byte = Number.parseInt(raster.hex.slice(offset, offset + 2), 16);
        ink = ((byte >> (7 - (column % 8))) & 1) === 1;
      }
      if (ink && runStart < 0) runStart = column;
      if (!ink && runStart >= 0) {
        canvas.fillRect(
          xPx + runStart * dotPx,
          yPx + row * dotPx,
          (column - runStart) * dotPx,
          dotPx,
        );
        runStart = -1;
      }
    }
  }
}

function drawText(
  canvas: LabelCanvas,
  element: TextLikeElement,
  text: string,
  scale: number,
): void {
  const fontPx = ptToMm(element.fontSizePt) * scale;
  canvas.font = `${element.bold ? 700 : 400} ${fontPx}px ${element.fontFamily ?? PRINT_FONT_FAMILY}`;
  canvas.fillStyle = INK;
  canvas.textBaseline = "top";
  const xPx = element.xMm * scale;
  const yPx = element.yMm * scale;
  // As the printer: alignment works only inside a `maxWidthMm` box.
  if (element.maxWidthMm === undefined) {
    canvas.textAlign = "left";
    canvas.fillText(text, xPx, yPx);
    return;
  }
  const boxPx = element.maxWidthMm * scale;
  const align = element.align ?? "left";
  canvas.textAlign = align;
  const drawX = align === "center" ? xPx + boxPx / 2 : align === "right" ? xPx + boxPx : xPx;
  // Wrapped and cut as print wraps and cuts it (`wrapTextToWidth`).
  const lines = wrapTextToWidth(
    text,
    (line) => canvas.measureText(line).width,
    boxPx,
    element.maxLines ?? 1,
  );
  const lineHeightPx = ptToMm(element.fontSizePt) * (element.lineHeight ?? LINE_HEIGHT_EM) * scale;
  lines.forEach((line, index) => {
    canvas.fillText(line, drawX, yPx + index * lineHeightPx, boxPx);
  });
}

/** A deterministic 32-bit hash of a string: the seed of a schematic code. */
function simpleHash(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

/** A seeded generator (mulberry32): the same seed, the same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A matrix code's schematic: a pattern seeded by its text, not a real encoding. */
function drawMatrixCode(
  canvas: LabelCanvas,
  text: string,
  xPx: number,
  yPx: number,
  modulePx: number,
): void {
  canvas.fillStyle = LABEL_BACKGROUND;
  canvas.fillRect(xPx, yPx, TOTAL_MODULES * modulePx, TOTAL_MODULES * modulePx);
  const random = mulberry32(simpleHash(text));
  canvas.fillStyle = INK;
  for (let row = 0; row < INTERIOR_MODULES; row++) {
    for (let column = 0; column < INTERIOR_MODULES; column++) {
      if (random() < 0.5) {
        canvas.fillRect(
          xPx + (QUIET_ZONE_MODULES + column) * modulePx,
          yPx + (QUIET_ZONE_MODULES + row) * modulePx,
          modulePx,
          modulePx,
        );
      }
    }
  }
}

/**
 * A linear code's schematic over the element's whole height and its real
 * printed width (`elementBoundsMm`); no digits under it, since neither
 * emitter asks the printer for them.
 */
function drawLinearCode(
  canvas: LabelCanvas,
  text: string,
  xPx: number,
  yPx: number,
  heightPx: number,
  widthPx: number,
): void {
  const value = text.length > 0 ? text : " ";
  const segmentPx = widthPx / (value.length * 2);
  canvas.fillStyle = LABEL_BACKGROUND;
  canvas.fillRect(xPx, yPx, widthPx, heightPx);
  canvas.fillStyle = INK;
  let cursor = xPx;
  for (let index = 0; index < value.length; index++) {
    const jitter = 0.6 + ((value.charCodeAt(index) % 9) / 8) * 0.8;
    canvas.fillRect(cursor, yPx, segmentPx * jitter, heightPx);
    cursor += segmentPx * 2;
  }
}

/** A product duplicate's code: the station prints it as its own GS1 raster. */
function isStationRaster(element: LabelBarcodeElement, options: LabelRenderOptions): boolean {
  return (
    options.kmDataMatrix === "raster" &&
    element.format === "datamatrix" &&
    element.data === "km.code"
  );
}

function drawBarcode(
  canvas: LabelCanvas,
  element: LabelBarcodeElement,
  scale: number,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
): void {
  // Left white here: `paintCodeRasters` paints the station's raster once its encoder loads.
  if (isStationRaster(element, options)) return;
  const text = typeof element.data === "string" ? (data[element.data] ?? "") : element.data.literal;
  const xPx = element.xMm * scale;
  const yPx = element.yMm * scale;
  if (element.format === "datamatrix" || element.format === "qr") {
    drawMatrixCode(canvas, text, xPx, yPx, element.sizeMm * scale);
    return;
  }
  const { w } = elementBoundsMm(element, data);
  drawLinearCode(canvas, text, xPx, yPx, element.sizeMm * scale, w * scale);
}

function drawLine(canvas: LabelCanvas, element: LabelLineElement, scale: number): void {
  canvas.strokeStyle = INK;
  canvas.lineWidth = element.thicknessMm * scale;
  canvas.beginPath();
  canvas.moveTo(element.xMm * scale, element.yMm * scale);
  canvas.lineTo(element.x2Mm * scale, element.y2Mm * scale);
  canvas.stroke();
}

function drawBox(canvas: LabelCanvas, element: LabelBoxElement, scale: number): void {
  const thicknessPx = element.thicknessMm * scale;
  canvas.strokeStyle = INK;
  canvas.lineWidth = thicknessPx;
  // Inset by half the stroke, so the outer edge is the element's own box.
  canvas.strokeRect(
    element.xMm * scale + thicknessPx / 2,
    element.yMm * scale + thicknessPx / 2,
    element.widthMm * scale - thicknessPx,
    element.heightMm * scale - thicknessPx,
  );
}

/**
 * Draws a layout at `scale` pixels per millimetre with `data` for its fields,
 * after the cloud's `renderer.ts`: the whole label white, then each element in
 * black. Text is drawn natively here; `compositeTextRasters` puts the print's
 * bitmaps over the text that needs them. Codes are schematic, except a product
 * duplicate's code (`kmDataMatrix: "raster"`), which stays white until
 * `paintCodeRasters` paints the station's raster.
 */
export function drawLabel(
  spec: LabelTemplateSpec,
  canvas: LabelCanvas,
  scale: number,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
): void {
  const widthPx = spec.widthMm * scale;
  const heightPx = spec.heightMm * scale;
  canvas.clearRect(0, 0, widthPx, heightPx);
  canvas.fillStyle = LABEL_BACKGROUND;
  canvas.fillRect(0, 0, widthPx, heightPx);
  for (const element of spec.elements) {
    switch (element.kind) {
      case "text":
        drawText(canvas, element, element.text, scale);
        break;
      case "field":
        drawText(canvas, element, textOf(element, data), scale);
        break;
      case "barcode":
        drawBarcode(canvas, element, scale, data, options);
        break;
      case "line":
        drawLine(canvas, element, scale);
        break;
      case "box":
        drawBox(canvas, element, scale);
        break;
      case "organization_logo":
        // The area stays white: this app has no organization logo to draw (pilot
        // question П15), and a print without a logo leaves it empty too.
        break;
    }
  }
}

/**
 * Paints a product duplicate's code as the station's GS1 raster, dot for dot
 * where the printer puts it. The encoder comes with the domain's printing code
 * (`label-print.ts`, a chunk of its own: bwip-js is large), so this waits for
 * it; a code it cannot encode, or an encoder that did not load, stays white,
 * and nothing is painted once `cancelled()` says the layout has changed.
 */
export async function paintCodeRasters(
  spec: LabelTemplateSpec,
  canvas: LabelCanvas,
  scale: number,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
  cancelled: () => boolean,
): Promise<void> {
  const codes = spec.elements.filter(
    (element): element is LabelBarcodeElement =>
      element.kind === "barcode" && isStationRaster(element, options),
  );
  if (codes.length === 0) return;
  const print = await import("./label-print.js").catch(() => null);
  if (print === null || cancelled()) return;
  const dotPx = (25.4 / spec.dpi) * scale;
  for (const code of codes) {
    let raster: RasterResult;
    try {
      raster = print.rasterizeGs1DataMatrix(data["km.code"], mmToDots(code.sizeMm, spec.dpi));
    } catch {
      continue;
    }
    const bounds = elementBoundsMm(code, data, options);
    paintRaster(
      canvas,
      raster,
      mmToDots(bounds.x, spec.dpi) * dotPx,
      mmToDots(bounds.y, spec.dpi) * dotPx,
      dotPx,
    );
  }
}

/**
 * Puts over a drawn layout the bitmaps the print carries
 * («предпросмотр = печать»): every text the print rasterizes
 * (`rasterTextElements`) goes to `rasterizeText` with the options the
 * domain's generators give it, its native drawing is covered with the label's
 * white (the element's estimated bounds and the bitmap's own rectangle: the
 * printer's bitmap is opaque), and the bitmap's black dots are painted where
 * the printer puts it: at the element's origin in whole dots plus the same
 * alignment offset (`rasterAlignOffsetDots`). An element whose bitmap fails
 * keeps its native drawing; nothing is painted once `cancelled()` says the
 * layout has changed.
 */
export async function compositeTextRasters(
  spec: LabelTemplateSpec,
  canvas: LabelCanvas,
  scale: number,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
  rasterizeText: RasterizeTextFn,
  cancelled: () => boolean,
): Promise<void> {
  const dotPx = (25.4 / spec.dpi) * scale;
  for (const element of rasterTextElements(spec, data)) {
    const text = textOf(element, data);
    const maxWidthDots =
      element.maxWidthMm === undefined ? undefined : mmToDots(element.maxWidthMm, spec.dpi);
    let raster: RasterResult | null;
    try {
      raster = await rasterizeText(text, {
        fontFamily: element.fontFamily ?? PRINT_FONT_FAMILY,
        ...(element.minFontSizePt === undefined
          ? {}
          : { minFontSizePx: ptToDots(element.minFontSizePt, spec.dpi) }),
        ...(element.lineHeight === undefined ? {} : { lineHeight: element.lineHeight }),
        fontSizePx: ptToDots(element.fontSizePt, spec.dpi),
        bold: element.bold ?? false,
        maxWidthPx: maxWidthDots,
        maxLines: element.maxLines ?? 1,
      });
    } catch {
      raster = null;
    }
    if (cancelled()) return;
    if (raster === null) continue;
    const bounds = elementBoundsMm(element, data, options);
    canvas.fillStyle = LABEL_BACKGROUND;
    canvas.fillRect(bounds.x * scale, bounds.y * scale, bounds.w * scale, bounds.h * scale);
    const offsetDots = rasterAlignOffsetDots(element.align, maxWidthDots, raster.width);
    const xPx = (mmToDots(element.xMm, spec.dpi) + offsetDots) * dotPx;
    const yPx = mmToDots(element.yMm, spec.dpi) * dotPx;
    // The bitmap is opaque on the printer's side: its blank dots are white too, so the
    // native text outside the heuristic bounds (centred, right-aligned, wider glyphs, more
    // lines) must not show through its own rectangle.
    canvas.fillRect(xPx, yPx, raster.width * dotPx, raster.height * dotPx);
    paintRaster(canvas, raster, xPx, yPx, dotPx);
  }
}
