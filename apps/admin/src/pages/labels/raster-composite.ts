/**
 * "Предпросмотр = печать": the raster-compositing pass that turns a
 * schematic `draw()` canvas into the pixels a thermal printer will actually
 * put on the label.
 *
 * `renderer.ts`'s `draw()` paints every `text`/`field` element with a plain
 * `ctx.fillText` in the browser's own font. That is not what prints: for any
 * element whose resolved text needs rasterization (`@markiro/domain`'s
 * `needsImageRendering` -- Cyrillic, CJK, ...), `generateZpl`/`generateTspl`
 * embed a monochrome bitmap produced by a `RasterizeTextFn`. This module
 * composites that SAME bitmap over the schematic paint, at the same print-dot
 * resolution, so a preview and a printed page cannot diverge.
 *
 * It lives beside `renderer.ts` rather than inside the editor because it has
 * two callers now: the editor's read-only preview pane
 * (`editor/PreviewPane.tsx`) and the KM print page
 * (`../km-orders/KmOrderPrintPage.tsx`), which puts one label per physical
 * page. Keeping one implementation is the whole point -- the office proofreads
 * the preview and then prints, so the two must be the same pixels.
 *
 * JSDOM NOTE: `canvas.getContext("2d")` returns `null` under jsdom (the
 * optional native `canvas` package is deliberately not a dependency, see
 * `labels/rasterizer.ts`), so this function is never reached by the admin
 * test suite -- callers skip it when they have no context. Its behaviour is
 * verified in a real browser only.
 */
import {
  labelFieldDisplayValue,
  mmToDots,
  needsImageRendering,
  ptToDots,
  rasterAlignOffsetDots,
  type LabelField,
  type LabelFieldElement,
  type LabelTemplateSpec,
  type LabelTextElement,
  type RasterizeTextFn,
} from "@markiro/domain";

import type { LabelFontFamily } from "../../labels/fontCoverage.js";
import { decodeRasterToRgba, dotsToMm, rasterDestXPx } from "./editor/raster-preview.js";
import { elementBoundsMm, LABEL_BACKGROUND_COLOR } from "./renderer.js";

/** `draw`'s own options object, named so callers can hold one as a constant. */
export type LabelRenderOptions = { kmDataMatrix?: "native" | "raster" };

export interface RasterCompositeOptions {
  fontFamily: LabelFontFamily;
  rasterizeText: RasterizeTextFn;
  renderOptions: LabelRenderOptions;
  /**
   * Answers `true` once the caller's effect has been cleaned up, so a long
   * label stops compositing onto a canvas nobody is looking at any more.
   */
  isCancelled?: () => boolean;
}

export function resolvedTextOf(
  element: LabelTextElement | LabelFieldElement,
  data: Record<LabelField, string>,
): string {
  return element.kind === "text"
    ? element.text
    : labelFieldDisplayValue(element.field, data, element.textFormat);
}

/**
 * Every text/field element whose RESOLVED text needs rasterization -- the set
 * that must be composited, and the set a font-coverage check is meaningful
 * for (an empty set means no check at all: the warning would be noise on a
 * label with no non-Latin1 text).
 */
export function elementsNeedingRaster(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
): Array<LabelTextElement | LabelFieldElement> {
  return spec.elements.filter(
    (el): el is LabelTextElement | LabelFieldElement =>
      (el.kind === "text" || el.kind === "field") && needsImageRendering(resolvedTextOf(el, data)),
  );
}

/**
 * Composites the real rasterized bitmap over `ctx` for every element that
 * needs one. `ctx` must already carry `draw`'s schematic paint at the same
 * `scale` (pixels per millimetre).
 *
 * A single element failing to rasterize -- a font-load edge case, a glyph the
 * rasterizer refuses -- leaves that element's schematic rendering in place
 * rather than blanking the whole label, and is never reported with the text
 * that caused it: on a KM label that text is a live marking code.
 */
export async function compositeRasterText(
  spec: LabelTemplateSpec,
  ctx: CanvasRenderingContext2D,
  scale: number,
  data: Record<LabelField, string>,
  options: RasterCompositeOptions,
): Promise<void> {
  const cancelled = options.isCancelled ?? (() => false);

  for (const element of elementsNeedingRaster(spec, data)) {
    const text = resolvedTextOf(element, data);
    try {
      const fontSizePx = ptToDots(element.fontSizePt, spec.dpi);
      const raster = await options.rasterizeText(text, {
        fontFamily: options.fontFamily,
        fontSizePx,
        bold: element.bold ?? false,
        ...(element.maxWidthMm !== undefined
          ? { maxWidthPx: mmToDots(element.maxWidthMm, spec.dpi) }
          : {}),
        maxLines: element.maxLines ?? 1,
      });
      if (cancelled()) return;

      const offscreen = document.createElement("canvas");
      offscreen.width = raster.width;
      offscreen.height = raster.height;
      const offCtx = offscreen.getContext("2d");
      if (!offCtx) continue;
      const rgba = decodeRasterToRgba(raster);
      offCtx.putImageData(new ImageData(rgba, raster.width, raster.height), 0, 0);

      // Mirror the same align/maxWidthMm offset `generateZpl`/`generateTspl`'s
      // raster branch applies (see `rasterAlignOffsetDots`'s doc comment in
      // `@markiro/domain`) so the composited bitmap's position never diverges
      // from print.
      const maxWidthDots =
        element.maxWidthMm !== undefined ? mmToDots(element.maxWidthMm, spec.dpi) : undefined;
      const offsetDots = rasterAlignOffsetDots(element.align, maxWidthDots, raster.width);
      const destXPx = rasterDestXPx(element.xMm, offsetDots, spec.dpi, scale);
      const destYPx = element.yMm * scale;
      const destWidthPx = dotsToMm(raster.width, spec.dpi) * scale;
      const destHeightPx = dotsToMm(raster.height, spec.dpi) * scale;

      // `draw()` already schematic-painted this element with a plain
      // `ctx.fillText` (see `renderer.ts`'s `drawTextElement`), whose
      // approximate `AVG_CHAR_WIDTH_EM`/`LINE_HEIGHT_EM` heuristic bounds
      // (`elementBoundsMm`) can be WIDER than the real rasterized bitmap about
      // to be drawn on top of it. Painting the label-background colour over
      // the schematic's own bounds FIRST ensures no stray schematic ink peeks
      // out from under or around the bitmap.
      const schematicBounds = elementBoundsMm(element, data, options.renderOptions);
      ctx.fillStyle = LABEL_BACKGROUND_COLOR;
      ctx.fillRect(
        schematicBounds.x * scale,
        schematicBounds.y * scale,
        schematicBounds.w * scale,
        schematicBounds.h * scale,
      );

      ctx.drawImage(offscreen, destXPx, destYPx, destWidthPx, destHeightPx);
    } catch {
      // This element keeps its schematic `draw()` rendering; nothing about the
      // failing text reaches a log or a message.
    }
  }
}
