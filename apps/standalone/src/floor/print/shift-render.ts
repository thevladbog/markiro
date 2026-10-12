import type { MonoBitmap, RasterizeTextFn } from "@markiro/domain";

import { labelLogo } from "../../labels/logo.js";
import { rasterizeText } from "../../labels/rasterizer.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import { renderLabel } from "./label-render.js";
import type { RenderLabel } from "./print-jobs.js";

/**
 * The one line a label without its logo leaves (the cloud station's
 * `console.error("station: box label render failed")` style): fixed text, the
 * label prints with the box empty, and nothing of the shift or the logo is in it.
 */
export const LOGO_UNAVAILABLE_LINE = "station: label logo unavailable, printing without it";

/** What a shift's render may be given instead of the app's own; tests give their own. */
export interface ShiftRenderDeps {
  rasterize?: RasterizeTextFn;
  /** The logo of a label: the shift's own, else a fallback; the app's is `labelLogo`. */
  loadLogo?: (own: MonoBitmap | null) => Promise<MonoBitmap | null>;
  /** The bundled Markiro logo the app's `loadLogo` falls back to. */
  fallbackLogo?: () => Promise<MonoBitmap>;
  /** Where the diagnostic line goes; the console by default. */
  report?: (line: string) => void;
}

/**
 * How the labels of `shift` are rendered (plan А4, #703): from the shift's
 * snapshot alone, as every label of the shift. A layout with an
 * `organization_logo` box prints the organization logo the shift froze, else
 * the bundled Markiro logo, else leaves the box empty; a layout without one
 * loads no logo. A logo that cannot be had never stops a label: the box is
 * empty and one diagnostic line says so (`LOGO_UNAVAILABLE_LINE`).
 */
export function shiftLabelRender(shift: WorkShift, deps: ShiftRenderDeps = {}): RenderLabel {
  const rasterize = deps.rasterize ?? rasterizeText;
  const report = deps.report ?? ((line: string) => console.error(line));
  const loadLogo =
    deps.loadLogo ??
    ((own: MonoBitmap | null) =>
      labelLogo(own, deps.fallbackLogo, () => {
        report(LOGO_UNAVAILABLE_LINE);
      }));
  return async (spec, fields, printer) => {
    let logo: MonoBitmap | null = null;
    if (spec.elements.some((element) => element.kind === "organization_logo")) {
      try {
        logo = await loadLogo(shift.snapshot.organization?.logo ?? null);
      } catch {
        report(LOGO_UNAVAILABLE_LINE);
      }
    }
    return renderLabel(spec, fields, printer, rasterize, logo);
  };
}
