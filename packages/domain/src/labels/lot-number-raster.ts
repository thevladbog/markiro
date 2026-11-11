import { DomainError } from "../errors.js";
import { mmToDots, ptToDots, type LabelFieldElement, type LabelTemplateSpec } from "./model.js";
import type { RasterizeTextFn, RasterizeTextOptions, RasterResult } from "./raster-types.js";

function overflow(id: string): never {
  throw new DomainError(
    "LABEL_LOT_NUMBER_OVERFLOW",
    `${id}: the complete lot number does not fit in its printable area`,
  );
}

/** Try all allowed lines at each size before reducing the font. */
export async function rasterizeCompleteLotNumber(
  id: string,
  text: string,
  rasterizeText: RasterizeTextFn,
  options: RasterizeTextOptions & { maxWidthPx: number },
  minSizePx: number,
  maxHeightPx: number,
): Promise<RasterResult> {
  if (options.maxWidthPx < 1 || maxHeightPx < 1) overflow(id);
  for (
    let fontSizePx = options.fontSizePx;
    fontSizePx >= minSizePx;
    fontSizePx = Math.max(minSizePx, fontSizePx - 1)
  ) {
    try {
      const raster = await rasterizeText(text, {
        ...options,
        fontSizePx,
        overflow: "error",
        containInk: true,
      });
      if (raster.width <= options.maxWidthPx && raster.height <= maxHeightPx) return raster;
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "LABEL_TEXT_OVERFLOW")) throw error;
    }
    if (fontSizePx === minSizePx) break;
  }
  return overflow(id);
}

export function lotNumberLabelWidthDots(
  element: LabelFieldElement,
  spec: Pick<LabelTemplateSpec, "dpi" | "widthMm">,
): number {
  const available = mmToDots(spec.widthMm, spec.dpi) - mmToDots(element.xMm, spec.dpi);
  return element.maxWidthMm === undefined
    ? available
    : Math.min(available, mmToDots(element.maxWidthMm, spec.dpi));
}

/** The preview, raw ZPL/TSPL and driver paths share the exact same text fitting. */
export async function rasterizeLabelLotNumber(
  element: LabelFieldElement,
  spec: Pick<LabelTemplateSpec, "dpi" | "widthMm" | "heightMm">,
  text: string,
  rasterizeText: RasterizeTextFn,
): Promise<RasterResult> {
  const { dpi } = spec;
  const x = mmToDots(element.xMm, dpi);
  const y = mmToDots(element.yMm, dpi);
  if (x < 0 || y < 0) overflow(element.id);
  const maxWidthPx = lotNumberLabelWidthDots(element, spec);
  const fontSizePx = ptToDots(element.fontSizePt, dpi);
  const maxLines = element.maxLines ?? 2;
  const lineHeight = element.lineHeight ?? 1.25;
  const maxHeightPx = Math.min(
    mmToDots(spec.heightMm, dpi) - y,
    Math.ceil(fontSizePx * lineHeight) * maxLines,
  );
  return rasterizeCompleteLotNumber(
    element.id,
    text,
    rasterizeText,
    {
      fontFamily: element.fontFamily ?? "monospace",
      fontSizePx,
      bold: element.bold ?? false,
      maxWidthPx,
      maxLines,
      lineHeight,
    },
    ptToDots(element.minFontSizePt ?? element.fontSizePt, dpi),
    maxHeightPx,
  );
}
