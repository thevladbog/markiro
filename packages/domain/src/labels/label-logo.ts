import { DomainError } from "../errors.js";
import { mmToDots, type LabelOrganizationLogoElement, type PrinterDpi } from "./model.js";
import { scaleMonoBitmap, validateMonoBitmap, type MonoBitmap } from "./mono-compose.js";
import type { RasterResult } from "./raster-types.js";

export function renderLabelLogo(
  element: LabelOrganizationLogoElement,
  dpi: PrinterDpi,
  logo?: MonoBitmap,
): { xDots: number; yDots: number; raster: RasterResult } {
  if (!logo)
    throw new DomainError(
      "LABEL_LOGO_REQUIRED",
      "Organization or fallback Markiro logo is required",
    );
  validateMonoBitmap(logo);
  const maxW = mmToDots(element.widthMm, dpi),
    maxH = mmToDots(element.heightMm, dpi);
  const scale = Math.min(maxW / logo.width, maxH / logo.height);
  const bitmap = scaleMonoBitmap(
    logo,
    Math.max(1, Math.round(logo.width * scale)),
    Math.max(1, Math.round(logo.height * scale)),
  );
  return {
    xDots: mmToDots(element.xMm, dpi),
    yDots: mmToDots(element.yMm, dpi) + Math.floor((maxH - bitmap.height) / 2),
    raster: {
      width: bitmap.width,
      height: bitmap.height,
      bytesPerRow: bitmap.stride,
      totalBytes: bitmap.pixels.length,
      hex: [...bitmap.pixels].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(""),
    },
  };
}
