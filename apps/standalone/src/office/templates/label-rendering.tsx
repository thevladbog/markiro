import { createContext, useContext, type ReactNode } from "react";

import type { RasterizeTextFn } from "@markiro/domain";

import type { LabelFontFamily } from "../../labels/font-coverage.js";
import { rasterizeText } from "../../labels/rasterizer.js";
import type { LabelCanvas } from "./label-renderer.js";

/**
 * What the office draws labels with: a canvas's 2D context, the text
 * rasterizer and the font coverage check. The webview's own by default; a
 * test passes its own (jsdom has no canvas, and a font file is not fetched
 * there), as the cloud's `LabelEditorPage` takes `rasterizeText` and
 * `checkFamilyCoverage` as props.
 */
export interface LabelRendering {
  /** A canvas's 2D context; `null` where the webview gives none. */
  context: (canvas: HTMLCanvasElement) => LabelCanvas | null;
  rasterizeText: RasterizeTextFn;
  checkFamilyCoverage: (family: LabelFontFamily) => Promise<boolean>;
}

/**
 * The webview's canvas, the bundled-font rasterizer and the check of the
 * bundled fonts; the check, with opentype.js, is a chunk of its own, loaded
 * the first time a layout has Cyrillic text.
 */
export const BROWSER_LABEL_RENDERING: LabelRendering = {
  context: (canvas) => canvas.getContext("2d"),
  rasterizeText,
  checkFamilyCoverage: async (family) => {
    const { checkFamilyCoverage } = await import("../../labels/font-coverage.js");
    return checkFamilyCoverage(family);
  },
};

const LabelRenderingContext = createContext<LabelRendering>(BROWSER_LABEL_RENDERING);

/** Gives the office below another way to draw labels (tests). */
export function LabelRenderingProvider({
  value,
  children,
}: {
  value: LabelRendering;
  children: ReactNode;
}) {
  return <LabelRenderingContext value={value}>{children}</LabelRenderingContext>;
}

/** How labels are drawn here. */
export function useLabelRendering(): LabelRendering {
  return useContext(LabelRenderingContext);
}
