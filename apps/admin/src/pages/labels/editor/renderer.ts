/**
 * Plan 04 Task 9: label editor canvas core -- shared renderer.
 *
 * `draw` paints a `LabelTemplateSpec` onto a real `CanvasRenderingContext2D`
 * at a given `scale` (pixels PER millimetre -- NOT a DPI/print-resolution
 * value; purely a canvas zoom factor chosen by the caller) using `data` to
 * resolve `field`/`barcode` element values. It is deliberately reusable by
 * three different call sites: the editor canvas (`LabelCanvas.tsx`, this
 * task), the live preview pane (Task 10), and library thumbnails (Task 8,
 * which may land before or after this task -- see the plan's own
 * execution-order note).
 *
 * Barcodes are rendered SCHEMATICALLY, never via a real symbology encoder:
 * `code128`/`ean13` draw deterministic bar stripes (widths derived from the
 * resolved text's own character codes) plus a caption; `datamatrix`/`qr`
 * draw a deterministic module grid derived from a simple hash of the
 * resolved text, with a blank quiet-zone margin. This mirrors the actual
 * print path's own division of labor: real barcode encoding only ever
 * happens on the PRINTER (ZPL `^BC`/`^BX`/`^BQ`, TSPL `BARCODE`/`DMATRIX`/
 * `QRCODE` -- see `@markiro/domain`'s `zpl.ts`/`tspl.ts`), never in this
 * admin-side preview, so there is no real encoder to call here even if we
 * wanted pixel-accurate bars.
 *
 * JSDOM NOTE (why this module has no direct unit test for `draw` itself):
 * `HTMLCanvasElement.prototype.getContext("2d")` returns `null` under jsdom
 * unless the optional native `canvas` package is installed (deliberately
 * NOT a dependency here -- see `labels/rasterizer.ts`'s identical note), so
 * `draw`'s actual pixel output can never be asserted in this test suite.
 * Only the PURE geometry helper below (`elementBoundsMm`) is unit-tested;
 * `draw`/`drawSelectionOutline` are exercised indirectly (called-or-skipped
 * based on whether a real 2D context is available) by `LabelCanvas.tsx`.
 */
import {
  type LabelBarcodeElement,
  type LabelBoxElement,
  type LabelElement,
  type LabelField,
  type LabelFieldElement,
  type LabelLineElement,
  type LabelTemplateSpec,
  type LabelTextElement,
} from "@markiro/domain";

/** An element's approximate bounding box, in millimetres, top-left anchored. */
export interface BoundsMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MM_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;

/**
 * Points -> millimetres, a plain typographic unit conversion independent of
 * any print DPI. NOT the same thing as `@markiro/domain`'s `ptToDots`
 * (which converts points to PRINTER DOTS at a given resolution) -- this
 * canvas renders at an arbitrary on-screen `scale` (px/mm), not at the
 * template's `dpi`, so a DPI-free conversion is what's needed here.
 */
function ptToMm(pt: number): number {
  return (pt / POINTS_PER_INCH) * MM_PER_INCH;
}

/**
 * Text/field bounds heuristic (documented per the plan brief's explicit
 * requirement): canvas cannot measure real glyph widths without a live 2D
 * context, which is unavailable under jsdom (see this module's doc comment
 * above) -- and even in a real browser, `elementBoundsMm` must stay a PURE,
 * synchronous function of the element alone (no ctx, no async font
 * loading), so it never calls `measureText`. Instead:
 *
 *  - Average glyph advance width is approximated as `0.55` of the font's em
 *    size. Real proportional glyphs vary roughly 0.2em ("i") to 1em ("W")
 *    wide; 0.55em is a common rule-of-thumb average for Latin/Cyrillic
 *    sans-serif text, good enough for hit-testing/selection/drag bounds but
 *    NOT a pixel-accurate layout measurement (only a live canvas 2D
 *    context, or the real print-time rasterizer in `labels/rasterizer.ts`,
 *    can provide that).
 *  - Line height is approximated as `1.5` of the font's em size -- the SAME
 *    ratio `labels/rasterizer.ts` already uses for its own (real,
 *    canvas-measured) text height heuristic, reused here rather than
 *    inventing a second, unrelated constant.
 */
const AVG_CHAR_WIDTH_EM = 0.55;
const LINE_HEIGHT_EM = 1.5;

/**
 * Linear barcode (code128/ean13) width heuristic. The model documents
 * `sizeMm` for these formats as the barcode's HEIGHT only (see
 * `LabelBarcodeElement` in `@markiro/domain`'s `model.ts`) -- printed width
 * depends on the real Code128/EAN-13 module math (start/stop patterns,
 * check digit, ~11 modules per character for Code128, etc.), which this
 * SCHEMATIC renderer does not implement. Width is instead approximated as
 * `charCount * BAR_WIDTH_PER_CHAR_FACTOR * sizeMm` -- i.e. each encoded
 * character is assumed to occupy roughly 0.7x the barcode's own height in
 * printed width, a plausible-looking aspect ratio, never intended to match
 * a real symbology's actual printed dimensions.
 */
const BAR_WIDTH_PER_CHAR_FACTOR = 0.7;

/**
 * Matrix code (datamatrix/qr) module-grid heuristic. The model documents
 * `sizeMm` for these formats as a SINGLE MODULE's square side, not the
 * overall symbol size (same `model.ts` comment as above) -- so the overall
 * schematic symbol size is `TOTAL_MODULES * sizeMm` on each axis.
 * `TOTAL_MODULES` is a FIXED constant, not derived from the encoded data's
 * real length via an actual DataMatrix/QR symbol-sizing table (out of scope
 * for a schematic preview): `INTERIOR_MODULES` (20) data modules plus a
 * blank `QUIET_ZONE_MODULES` (2) margin on every side, matching real
 * symbology quiet-zone requirements conceptually rather than any specific
 * standard's exact minimum.
 */
const INTERIOR_MODULES = 20;
const QUIET_ZONE_MODULES = 2;
const TOTAL_MODULES = INTERIOR_MODULES + QUIET_ZONE_MODULES * 2;

/**
 * Resolves the display text `elementBoundsMm` measures for a `text`/`field`
 * element. `text` elements carry their own literal string; `field`
 * elements resolve from the provided `data` record. Callers MUST pass the
 * SAME data used by `draw`; there is no fallback -- the bounds and the
 * actual rendered size must always agree, matching the on-canvas render.
 */
function resolveTextForBounds(
  element: LabelTextElement | LabelFieldElement,
  data: Record<LabelField, string>,
): string {
  return element.kind === "text" ? element.text : (data[element.field] ?? "");
}

/** Same requirement as `resolveTextForBounds`: callers pass the data used by `draw`. */
function resolveBarcodeTextForBounds(
  element: LabelBarcodeElement,
  data: Record<LabelField, string>,
): string {
  return typeof element.data === "string" ? (data[element.data] ?? "") : element.data.literal;
}

/**
 * Pure geometry: approximates `element`'s on-label bounding box in
 * millimetres, top-left anchored at `(element.xMm, element.yMm)` --
 * matching how `@markiro/domain`'s ZPL/TSPL emitters themselves position
 * every element kind (ZPL `^FO`/TSPL coordinates are always the upper-left
 * corner, never a center or baseline; alignment, where it applies, only
 * shifts text WITHIN its box, never the box's own origin -- see `zpl.ts`'s
 * `renderTextLikeElement`). Used for hit-testing (`hitTest` in
 * `LabelCanvas.tsx`), drag bounds, and the selected-element outline.
 *
 * CRITICAL: `data` is REQUIRED and must be the SAME data used by `draw`.
 * Bounds and rendered size must always agree; callers MUST pass the actual
 * data, never relying on sample fallbacks. This ensures hit-testing, drag
 * bounds, and selection outlines all match the actual on-screen render.
 *
 * See the heuristic constants above for exactly how `text`/`field`/
 * `barcode` sizes are approximated; `line`/`box` bounds are exact (derived
 * directly from the element's own documented geometry fields, no
 * heuristic needed).
 */
export function elementBoundsMm(element: LabelElement, data: Record<LabelField, string>): BoundsMm {
  switch (element.kind) {
    case "text":
    case "field": {
      const text = resolveTextForBounds(element, data);
      const w =
        element.maxWidthMm ??
        Math.max(text.length, 1) * ptToMm(element.fontSizePt) * AVG_CHAR_WIDTH_EM;
      const h = ptToMm(element.fontSizePt) * LINE_HEIGHT_EM;
      return { x: element.xMm, y: element.yMm, w, h };
    }
    case "barcode": {
      if (element.format === "datamatrix" || element.format === "qr") {
        const side = TOTAL_MODULES * element.sizeMm;
        return { x: element.xMm, y: element.yMm, w: side, h: side };
      }
      const text = resolveBarcodeTextForBounds(element, data);
      const w = Math.max(text.length, 1) * BAR_WIDTH_PER_CHAR_FACTOR * element.sizeMm;
      return { x: element.xMm, y: element.yMm, w, h: element.sizeMm };
    }
    case "line": {
      // Mirrors `zpl.ts`'s `renderLineElement`: a perfectly horizontal or
      // vertical line still needs a non-zero hit-testable thickness on its
      // thin axis, so each axis is clamped up to at least `thicknessMm`.
      const x = Math.min(element.xMm, element.x2Mm);
      const y = Math.min(element.yMm, element.y2Mm);
      const w = Math.max(Math.abs(element.x2Mm - element.xMm), element.thicknessMm);
      const h = Math.max(Math.abs(element.y2Mm - element.yMm), element.thicknessMm);
      return { x, y, w, h };
    }
    case "box":
      return { x: element.xMm, y: element.yMm, w: element.widthMm, h: element.heightMm };
  }
}

function mmToPx(mm: number, scale: number): number {
  return mm * scale;
}

/**
 * The schematic renderer always draws pure black ink on a white label
 * background, regardless of the admin app's own light/dark theme -- a
 * label preview must show what the THERMAL PRINTER will actually produce
 * (black ink on label stock), not follow the surrounding UI's palette.
 */
const LABEL_BACKGROUND_COLOR = "#ffffff";
const INK_COLOR = "#000000";

function drawTextElement(
  ctx: CanvasRenderingContext2D,
  element: LabelTextElement | LabelFieldElement,
  text: string,
  scale: number,
): void {
  const fontPx = ptToMm(element.fontSizePt) * scale;
  ctx.font = `${element.bold ? 700 : 400} ${fontPx}px sans-serif`;
  ctx.fillStyle = INK_COLOR;
  ctx.textBaseline = "top";

  const xPx = mmToPx(element.xMm, scale);
  const yPx = mmToPx(element.yMm, scale);

  // Matches `zpl.ts`'s own rule: alignment only shifts text WITHIN an
  // explicit `maxWidthMm` box (ZPL's `^FB` block); without one, text is
  // always drawn flush-left from `(xMm, yMm)` regardless of `align`.
  if (element.maxWidthMm !== undefined) {
    const boxWidthPx = mmToPx(element.maxWidthMm, scale);
    const align = element.align ?? "left";
    ctx.textAlign = align;
    const drawX =
      align === "center" ? xPx + boxWidthPx / 2 : align === "right" ? xPx + boxWidthPx : xPx;
    ctx.fillText(text, drawX, yPx, boxWidthPx);
  } else {
    ctx.textAlign = "left";
    ctx.fillText(text, xPx, yPx);
  }
}

/**
 * Deterministic 32-bit string hash (FNV-1a-style multiply/xor mix) --
 * same input string always produces the same seed, satisfying the plan
 * brief's "deterministic module pattern derived from a simple hash of
 * data" requirement for matrix-code schematics.
 */
export function simpleHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** Deterministic seeded PRNG (mulberry32) -- same seed always yields the same output sequence. */
export function mulberry32(seed: number): () => number {
  let state = seed;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawMatrixCode(
  ctx: CanvasRenderingContext2D,
  text: string,
  xPx: number,
  yPx: number,
  modulePx: number,
): void {
  const totalPx = TOTAL_MODULES * modulePx;
  ctx.fillStyle = LABEL_BACKGROUND_COLOR;
  ctx.fillRect(xPx, yPx, totalPx, totalPx);

  const random = mulberry32(simpleHash(text));
  ctx.fillStyle = INK_COLOR;
  for (let row = 0; row < INTERIOR_MODULES; row++) {
    for (let col = 0; col < INTERIOR_MODULES; col++) {
      if (random() < 0.5) {
        const moduleX = xPx + (QUIET_ZONE_MODULES + col) * modulePx;
        const moduleY = yPx + (QUIET_ZONE_MODULES + row) * modulePx;
        ctx.fillRect(moduleX, moduleY, modulePx, modulePx);
      }
    }
  }
}

function drawLinearBarcode(
  ctx: CanvasRenderingContext2D,
  text: string,
  xPx: number,
  yPx: number,
  heightPx: number,
): void {
  const value = text.length > 0 ? text : " ";
  // Bars occupy the top ~70% of the element's height; the bottom ~30% is
  // reserved for the human-readable caption -- kept WITHIN the same
  // `elementBoundsMm` box (never overflowing it) so the drawn footprint and
  // the hit-tested/selected bounding box always agree.
  const barsHeightPx = heightPx * 0.7;
  const widthPx = Math.max(value.length, 1) * BAR_WIDTH_PER_CHAR_FACTOR * heightPx;
  const segmentWidthPx = widthPx / (value.length * 2);

  ctx.fillStyle = LABEL_BACKGROUND_COLOR;
  ctx.fillRect(xPx, yPx, widthPx, barsHeightPx);

  ctx.fillStyle = INK_COLOR;
  let cursorPx = xPx;
  for (let i = 0; i < value.length; i++) {
    // Deterministic per-character bar-width jitter (60%-140% of the base
    // segment width), purely for a plausible "varying bar widths" look --
    // NOT a real Code128/EAN-13 module encoding.
    const code = value.charCodeAt(i);
    const jitter = 0.6 + ((code % 9) / 8) * 0.8;
    ctx.fillRect(cursorPx, yPx, segmentWidthPx * jitter, barsHeightPx);
    cursorPx += segmentWidthPx * 2;
  }

  ctx.fillStyle = INK_COLOR;
  ctx.font = `400 ${Math.max(barsHeightPx * 0.3, 6)}px monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(value, xPx, yPx + barsHeightPx);
}

function resolveBarcodeText(
  element: LabelBarcodeElement,
  data: Record<LabelField, string>,
): string {
  return typeof element.data === "string" ? (data[element.data] ?? "") : element.data.literal;
}

function drawBarcodeElement(
  ctx: CanvasRenderingContext2D,
  element: LabelBarcodeElement,
  data: Record<LabelField, string>,
  scale: number,
): void {
  const text = resolveBarcodeText(element, data);
  const xPx = mmToPx(element.xMm, scale);
  const yPx = mmToPx(element.yMm, scale);

  if (element.format === "datamatrix" || element.format === "qr") {
    drawMatrixCode(ctx, text, xPx, yPx, mmToPx(element.sizeMm, scale));
    return;
  }
  drawLinearBarcode(ctx, text, xPx, yPx, mmToPx(element.sizeMm, scale));
}

function drawLineElement(
  ctx: CanvasRenderingContext2D,
  element: LabelLineElement,
  scale: number,
): void {
  const thicknessPx = mmToPx(element.thicknessMm, scale);
  ctx.strokeStyle = INK_COLOR;
  ctx.lineWidth = thicknessPx;
  ctx.beginPath();
  ctx.moveTo(mmToPx(element.xMm, scale), mmToPx(element.yMm, scale));
  ctx.lineTo(mmToPx(element.x2Mm, scale), mmToPx(element.y2Mm, scale));
  ctx.stroke();
}

function drawBoxElement(
  ctx: CanvasRenderingContext2D,
  element: LabelBoxElement,
  scale: number,
): void {
  const thicknessPx = mmToPx(element.thicknessMm, scale);
  ctx.strokeStyle = INK_COLOR;
  ctx.lineWidth = thicknessPx;
  // Inset by half the stroke width so the stroked rect's OUTER edge lines
  // up with the element's own `(xMm, yMm, widthMm, heightMm)` box, matching
  // `canvas.strokeRect`'s center-stroked convention.
  ctx.strokeRect(
    mmToPx(element.xMm, scale) + thicknessPx / 2,
    mmToPx(element.yMm, scale) + thicknessPx / 2,
    mmToPx(element.widthMm, scale) - thicknessPx,
    mmToPx(element.heightMm, scale) - thicknessPx,
  );
}

/**
 * Draws `spec` onto `ctx` at `scale` (pixels per millimetre) using `data`
 * to resolve `field`/`barcode` element values. Clears and repaints the
 * whole `widthMm x heightMm` label area on every call -- callers (e.g.
 * `LabelCanvas.tsx`) are responsible for calling this only when a real 2D
 * context is available (`canvas.getContext("2d")` returns `null` under
 * jsdom, see this module's doc comment) and for re-invoking it whenever
 * `spec`/`scale`/`data` change; this function itself holds no state and
 * does no diffing.
 */
export function draw(
  spec: LabelTemplateSpec,
  ctx: CanvasRenderingContext2D,
  scale: number,
  data: Record<LabelField, string>,
): void {
  const widthPx = mmToPx(spec.widthMm, scale);
  const heightPx = mmToPx(spec.heightMm, scale);

  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = LABEL_BACKGROUND_COLOR;
  ctx.fillRect(0, 0, widthPx, heightPx);

  for (const element of spec.elements) {
    switch (element.kind) {
      case "text":
        drawTextElement(ctx, element, element.text, scale);
        break;
      case "field":
        drawTextElement(ctx, element, data[element.field] ?? "", scale);
        break;
      case "barcode":
        drawBarcodeElement(ctx, element, data, scale);
        break;
      case "line":
        drawLineElement(ctx, element, scale);
        break;
      case "box":
        drawBoxElement(ctx, element, scale);
        break;
    }
  }
}

/**
 * Selection-highlight blue (`#1a4f9c`), matching the design handoff
 * prototype's own DataMatrix selection outline
 * (`docs/design-briefs/design_handoff_markiro/prototypes/admin-panel.dc.html`,
 * "Редактор этикетки" screen). Deliberately distinct from
 * `packages/ui/src/tokens.css`'s `--accent` (brand green, reserved for the
 * module mark and key CTAs only per that file's own comment) -- this is a
 * canvas 2D stroke color, not a CSS value, and represents a different
 * concept (a transient selection highlight, not brand identity) anyway.
 */
const SELECTION_COLOR = "#1a4f9c";
const SELECTION_OUTLINE_OFFSET_PX = 3;
const SELECTION_OUTLINE_WIDTH_PX = 2;

/**
 * Draws the selected-element outline used by `LabelCanvas.tsx`, offset
 * outward from `bounds` (in millimetres, as returned by `elementBoundsMm`)
 * so the stroke never overlaps the element's own content. Kept in this
 * module (rather than inline in `LabelCanvas.tsx`) so the editor and any
 * future consumer share one visual definition of "selected" -- library
 * thumbnails (Task 8) and the read-only preview pane (Task 10) simply never
 * call this function, since they have no selection concept.
 */
export function drawSelectionOutline(
  ctx: CanvasRenderingContext2D,
  bounds: BoundsMm,
  scale: number,
): void {
  ctx.save();
  ctx.strokeStyle = SELECTION_COLOR;
  ctx.lineWidth = SELECTION_OUTLINE_WIDTH_PX;
  ctx.strokeRect(
    mmToPx(bounds.x, scale) - SELECTION_OUTLINE_OFFSET_PX,
    mmToPx(bounds.y, scale) - SELECTION_OUTLINE_OFFSET_PX,
    mmToPx(bounds.w, scale) + SELECTION_OUTLINE_OFFSET_PX * 2,
    mmToPx(bounds.h, scale) + SELECTION_OUTLINE_OFFSET_PX * 2,
  );
  ctx.restore();
}
