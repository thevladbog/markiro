/**
 * Shared label renderer. Lives at `pages/labels/` (NOT under `editor/`)
 * because the visual editor it was born with is gone (spec 2026-08-20): its
 * remaining consumers are the library screen's card thumbnails
 * (`TemplateThumb.tsx`) and the editor page's read-only preview pane
 * (`editor/PreviewPane.tsx`), neither of which is part of an interactive
 * canvas.
 *
 * `draw` paints a `LabelTemplateSpec` onto a real `CanvasRenderingContext2D`
 * at a given `scale` (pixels PER millimetre -- NOT a DPI/print-resolution
 * value; purely a canvas zoom factor chosen by the caller) using `data` to
 * resolve `field`/`barcode` element values.
 *
 * Barcodes are rendered SCHEMATICALLY, never via a real symbology encoder:
 * `code128`/`ean13` draw deterministic bar stripes (widths derived from the
 * resolved text's own character codes) and nothing else; `datamatrix`/`qr`
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
 * Only the PURE helpers below (`elementBoundsMm`, `simpleHash`,
 * `mulberry32`) are unit-tested; `draw` is exercised indirectly
 * (called-or-skipped based on whether a real 2D context is available) by
 * `TemplateThumb.tsx` and `editor/PreviewPane.tsx`.
 */
import {
  BAR_WIDTH_PER_CHAR_FACTOR,
  elementBoundsMm,
  INTERIOR_MODULES,
  LINE_HEIGHT_EM,
  ptToMm,
  QUIET_ZONE_MODULES,
  TOTAL_MODULES,
  wrapTextToWidth,
  type BoundsMm,
  type LabelBarcodeElement,
  type LabelBoxElement,
  type LabelField,
  type LabelLineElement,
  type LabelTemplateSpec,
  type LabelTextElement,
  type LabelFieldElement,
} from "@markiro/domain";

/**
 * `elementBoundsMm` and its `BoundsMm` type moved into `@markiro/domain`
 * (`labels/bounds.ts`) so `packages/domain`'s own tests can assert that the
 * stock templates' rendered EXTENTS stay on the label -- the check that
 * catches a product name printing off the right edge. Re-exported here
 * unchanged so this module stays the app's single import site for label
 * geometry (`geometry.ts`, `PreviewPane.tsx`, and the geometry tests all keep
 * importing it from `renderer.js`).
 */
export { elementBoundsMm };
export type { BoundsMm };

function mmToPx(mm: number, scale: number): number {
  return mm * scale;
}

/**
 * The schematic renderer always draws pure black ink on a white label
 * background, regardless of the admin app's own light/dark theme -- a
 * label preview must show what the THERMAL PRINTER will actually produce
 * (black ink on label stock), not follow the surrounding UI's palette.
 */
export const LABEL_BACKGROUND_COLOR = "#ffffff";
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
  if (element.maxWidthMm === undefined) {
    ctx.textAlign = "left";
    ctx.fillText(text, xPx, yPx);
    return;
  }

  // Wrapped/ellipsized exactly like print: `maxWidthMm` is a real constraint
  // now (see `@markiro/domain`'s `wrap.ts`), so the schematic must break the
  // same way rather than squeezing everything onto one condensed line and
  // showing an operator a layout the printer will never produce.
  const boxWidthPx = mmToPx(element.maxWidthMm, scale);
  const align = element.align ?? "left";
  ctx.textAlign = align;
  const drawX =
    align === "center" ? xPx + boxWidthPx / 2 : align === "right" ? xPx + boxWidthPx : xPx;
  const lines = wrapTextToWidth(
    text,
    (s) => ctx.measureText(s).width,
    boxWidthPx,
    element.maxLines ?? 1,
  );
  const lineHeightPx = ptToMm(element.fontSizePt) * LINE_HEIGHT_EM * scale;
  lines.forEach((line, i) => {
    ctx.fillText(line, drawX, yPx + i * lineHeightPx, boxWidthPx);
  });
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
  // Bars fill the WHOLE element height. There is no human-readable caption
  // any more: neither emitter asks the printer for an interpretation line
  // (see `@markiro/domain`'s `zpl.ts`/`tspl.ts` -- they used to disagree, so
  // the same template printed digits on a TSC and none on a Zebra), and a
  // preview that drew one would promise ink the printer never lays down. A
  // template that wants readable digits places its own text/field element
  // beneath the barcode, which this renderer draws like any other text.
  const barsHeightPx = heightPx;
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
 * `TemplateThumb.tsx`) are responsible for calling this only when a real 2D
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
