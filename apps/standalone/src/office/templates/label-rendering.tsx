import { createContext, useContext, type ReactNode } from "react";

import type { RasterizeTextFn } from "@markiro/domain";

import type { LabelFontFamily } from "../../labels/font-coverage.js";
import { rasterizeText } from "../../labels/rasterizer.js";
import type { LabelCanvas } from "./label-renderer.js";

/**
 * What the office draws labels with: a canvas's 2D context, the text
 * rasterizer, the font coverage check and a way to tell when a thumbnail
 * comes on screen. The webview's own by default; a test passes its own
 * (jsdom has no canvas, and a font file is not fetched there), as the
 * cloud's `LabelEditorPage` takes `rasterizeText` and `checkFamilyCoverage`
 * as props.
 */
export interface LabelRendering {
  /** A canvas's 2D context; `null` where the webview gives none. */
  context: (canvas: HTMLCanvasElement) => LabelCanvas | null;
  rasterizeText: RasterizeTextFn;
  checkFamilyCoverage: (family: LabelFontFamily) => Promise<boolean>;
  /** Calls `onVisible` once the element comes near the screen; returns what stops watching. */
  whenVisible: (element: Element, onVisible: () => void) => () => void;
}

/**
 * Watches with an `IntersectionObserver`, 200 px ahead of the screen; a
 * webview without one shows every thumbnail at once.
 */
function whenVisible(element: Element, onVisible: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return () => undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      onVisible();
    },
    { rootMargin: "200px" },
  );
  observer.observe(element);
  return () => observer.disconnect();
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
  whenVisible,
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
