/**
 * Pure, DOM-free geometry: an element's approximate printed footprint in
 * millimetres.
 *
 * WHY IT LIVES IN THE DOMAIN PACKAGE (it used to be
 * `apps/admin/src/pages/labels/renderer.ts`'s private helper): it is the ONLY
 * thing that can answer "does this template's content actually stay on the
 * label?", and that question has to be answerable from `packages/domain`'s
 * own tests — `test/labels-defaults.test.ts` asserts the stock templates'
 * rendered EXTENTS, not merely their origins, which is exactly the check that
 * would have caught the product name printing off the right edge. The admin
 * app re-exports this function unchanged, so preview bounds, the
 * `fitSpecElements` containment check, and the default-template drift guard
 * all share one heuristic instead of three that can drift.
 *
 * It is a HEURISTIC, not a measurement: it must stay pure and synchronous
 * (no canvas, no font loading), so glyph advances are approximated by
 * `wrap.ts`'s `AVG_CHAR_WIDTH_EM` and the line box by `LINE_HEIGHT_EM` — the
 * same constants the real wrapping uses. Good enough for containment checks
 * and overlay placement, never a pixel-accurate layout.
 */
import { code128ModuleCount, EAN13_MODULES } from "./code128.js";
import {
  labelFieldDisplayValue,
  type LabelBarcodeElement,
  type LabelElement,
  type LabelField,
  type LabelFieldElement,
  type LabelTextElement,
} from "./model.js";
import { estimatedLineCount, estimatedTextWidthMm, LINE_HEIGHT_EM, ptToMm } from "./wrap.js";

/** An element's approximate bounding box, in millimetres, top-left anchored. */
export interface BoundsMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Linear barcode (code128/ean13) width heuristic, used ONLY for an element
 * that declares no `moduleWidthMm`. The model documents `sizeMm` for these
 * formats as the barcode's HEIGHT only, so with no X-dimension to work from
 * there is nothing to derive a real width from and it is approximated as
 * `charCount * 0.7 * sizeMm` — a shape, not a measurement.
 *
 * An element that DOES declare `moduleWidthMm` gets the real thing instead
 * (see `linearBarcodeWidthMm`): `code128.ts`'s module count is exact, so the
 * bounds — and therefore the admin preview and the containment checks — agree
 * with the ink the printer lays down rather than with a fudge factor.
 */
export const BAR_WIDTH_PER_CHAR_FACTOR = 0.7;

/**
 * Matrix code (datamatrix/qr) module-grid heuristic: `sizeMm` is a SINGLE
 * module's square side, so the symbol is `TOTAL_MODULES * sizeMm` per axis —
 * `INTERIOR_MODULES` data modules plus a blank `QUIET_ZONE_MODULES` margin on
 * every side (conceptually matching real quiet-zone requirements, not any
 * specific standard's exact minimum).
 */
export const INTERIOR_MODULES = 20;
export const QUIET_ZONE_MODULES = 2;
export const TOTAL_MODULES = INTERIOR_MODULES + QUIET_ZONE_MODULES * 2;

function resolveTextForBounds(
  element: LabelTextElement | LabelFieldElement,
  data: Record<LabelField, string>,
): string {
  return element.kind === "text" ? element.text : labelFieldDisplayValue(element.field, data);
}

function resolveBarcodeTextForBounds(
  element: LabelBarcodeElement,
  data: Record<LabelField, string>,
): string {
  return typeof element.data === "string" ? (data[element.data] ?? "") : element.data.literal;
}

/**
 * A `code128`/`ean13` element's printed WIDTH in millimetres.
 *
 * With an explicit `moduleWidthMm` this is exact rather than a heuristic:
 * `moduleCount × X-dimension` is literally how wide the printer draws the
 * symbol. EAN-13 is a fixed 95 modules; Code 128's count comes from
 * `code128.ts`, costed against the payload the EMITTERS will actually encode
 * — which is why the `sscc` field is special-cased here exactly as it is in
 * `zpl.ts`/`tspl.ts`: those add the `(00)` application identifier and the
 * FNC1 flag themselves, so an 18-digit SSCC is really a 20-digit GS1-128 and
 * costs 11 extra modules for the flag. Getting that wrong by one symbol is a
 * whole 11 modules — 1.4 mm at a 0.125 mm X-dimension — of preview lie.
 *
 * Without `moduleWidthMm` there is no X-dimension to multiply, so the legacy
 * character-count approximation stands (see `BAR_WIDTH_PER_CHAR_FACTOR`) and
 * every template authored before that field existed keeps its previous
 * bounds unchanged.
 */
function linearBarcodeWidthMm(
  element: LabelBarcodeElement,
  data: Record<LabelField, string>,
): number {
  const text = resolveBarcodeTextForBounds(element, data);
  if (element.moduleWidthMm === undefined) {
    return Math.max(text.length, 1) * BAR_WIDTH_PER_CHAR_FACTOR * element.sizeMm;
  }
  if (element.format === "ean13") return EAN13_MODULES * element.moduleWidthMm;
  const gs1 = element.data === "sscc";
  return code128ModuleCount(gs1 ? `00${text}` : text, gs1) * element.moduleWidthMm;
}

/**
 * Approximates `element`'s on-label bounding box, top-left anchored at
 * `(element.xMm, element.yMm)` — matching how the ZPL/TSPL emitters position
 * every element kind (`^FO`/TSPL coordinates are always the upper-left
 * corner; alignment only shifts text WITHIN its box, never the box's origin).
 *
 * `maxWidthMm` CAPS the width rather than defining it (the emitters now
 * genuinely clip/wrap to it — see `wrap.ts`), and the height grows with the
 * number of lines the text will actually occupy, so `x + w` / `y + h` are an
 * honest statement of what gets printed. Reporting `maxWidthMm` AS the width
 * — the previous behaviour — was what let a 76 mm-wide product name pass a
 * 58 mm label's containment check.
 *
 * `data` is REQUIRED and must be the SAME data the caller renders with:
 * bounds and rendered size have to agree.
 */
export function elementBoundsMm(element: LabelElement, data: Record<LabelField, string>): BoundsMm {
  switch (element.kind) {
    case "text":
    case "field": {
      const text = resolveTextForBounds(element, data);
      const natural = estimatedTextWidthMm(text, element.fontSizePt);
      const w = element.maxWidthMm === undefined ? natural : Math.min(natural, element.maxWidthMm);
      const lines = estimatedLineCount(
        text,
        element.fontSizePt,
        element.maxWidthMm,
        element.maxLines,
      );
      const h = ptToMm(element.fontSizePt) * LINE_HEIGHT_EM * lines;
      return { x: element.xMm, y: element.yMm, w, h };
    }
    case "barcode": {
      if (element.format === "datamatrix" || element.format === "qr") {
        const side = TOTAL_MODULES * element.sizeMm;
        return { x: element.xMm, y: element.yMm, w: side, h: side };
      }
      const w = linearBarcodeWidthMm(element, data);
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
