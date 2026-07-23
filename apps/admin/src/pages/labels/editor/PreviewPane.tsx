/**
 * Plan 04 Task 10: label editor chrome -- the live preview pane.
 *
 * "предпросмотр = печать" (per the handoff's own preview caption): this
 * pane doesn't just reuse Task 9's schematic `draw()` (native `ctx.fillText`
 * for every text/field element, regardless of script) -- for any element
 * whose resolved text needs rasterization (`@markiro/domain`'s
 * `needsImageRendering`: Cyrillic, CJK, etc.), it runs the REAL rasterizer
 * (`rasterizeText`, injected, defaulting to `labels/rasterizer.ts`'s browser
 * `<canvas>` implementation -- the exact function `generateZpl`/
 * `generateTspl` themselves call) and composites the returned monochrome
 * bitmap on top, at the SAME print-dot resolution the actual document will
 * embed. What's on screen here is the same bitmap that ships in the printed
 * ZPL/TSPL, not merely a font-substitute approximation of it.
 *
 * TWO SEPARATE EFFECTS, deliberately:
 *  - The DRAW effect (schematic paint + raster compositing) needs a real 2D
 *    canvas context, which jsdom does not provide (see `renderer.ts`'s
 *    identical constraint) -- it silently no-ops there, same as
 *    `LabelCanvas.tsx`/`TemplateThumb.tsx`.
 *  - The COVERAGE-CHECK effect (which font-coverage Alert, if any, to show)
 *    has NOTHING to do with canvas pixels -- it must run and be assertable
 *    under jsdom too, since that's the only way this task's test suite can
 *    pin the "coverage false -> warn" / "coverage check throws -> a
 *    SEPARATE, honest 'could not verify' warn" behavior the brief requires.
 *    Splitting it into its own effect keeps it independent of whether a
 *    canvas happens to be available.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  needsImageRendering,
  ptToDots,
  sampleLabelData,
  type LabelField,
  type LabelFieldElement,
  type LabelTemplateSpec,
  type LabelTextElement,
  type RasterizeTextFn,
} from "@markiro/domain";
import { Alert } from "@markiro/ui";

import {
  checkFamilyCoverage as realCheckFamilyCoverage,
  type LabelFontFamily,
} from "../../../labels/fontCoverage.js";
import { rasterizeText as realRasterizeText } from "../../../labels/rasterizer.js";
import { decodeRasterToRgba } from "./raster-preview.js";
import { draw } from "./renderer.js";

/**
 * MVP SIMPLIFICATION (documented, not an oversight): `LabelTextElement`/
 * `LabelFieldElement` (`@markiro/domain`'s `model.ts`) carry no per-element
 * font-family field -- the domain model has no such concept yet (custom
 * font selection/upload is explicitly out of this plan's scope, see
 * `fontCoverage.ts`'s own doc comment) -- so there is exactly ONE
 * admin-wide font family the coverage check ever runs against, this
 * constant, rather than a per-element selector.
 */
export const PREVIEW_FONT_FAMILY: LabelFontFamily = "IBM Plex Sans";

/** Stable fallback sample data -- a MODULE-level constant (not a fresh
 * `sampleLabelData()` call per render) so omitting the `data` prop doesn't
 * churn the effect's dependency array with a new object identity every
 * render (`sampleLabelData()`'s return value is itself always identical in
 * content -- there is no reason to reallocate it). */
const DEFAULT_SAMPLE_DATA = sampleLabelData();

const DEFAULT_SCALE = 3;

export interface PreviewPaneProps {
  spec: LabelTemplateSpec;
  data?: Record<LabelField, string>;
  scale?: number;
  rasterizeText?: RasterizeTextFn;
  checkFamilyCoverage?: (family: LabelFontFamily) => Promise<boolean>;
}

function resolvedTextOf(
  element: LabelTextElement | LabelFieldElement,
  data: Record<LabelField, string>,
): string {
  return element.kind === "text" ? element.text : (data[element.field] ?? "");
}

function dotsToMm(dots: number, dpi: number): number {
  return (dots / dpi) * 25.4;
}

/** Every text/field element whose RESOLVED text needs rasterization -- the
 * set this pane must both (a) actually rasterize-and-composite, and (b) run
 * the font-coverage check for (an empty set means no coverage check at all:
 * the warning would be meaningless noise on a label with no non-Latin1 text). */
function elementsNeedingRaster(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
): Array<LabelTextElement | LabelFieldElement> {
  return spec.elements.filter(
    (el): el is LabelTextElement | LabelFieldElement =>
      (el.kind === "text" || el.kind === "field") && needsImageRendering(resolvedTextOf(el, data)),
  );
}

type CoverageStatus = "ok" | "missing" | "check-failed";

export function PreviewPane({
  spec,
  data,
  scale = DEFAULT_SCALE,
  rasterizeText = realRasterizeText,
  checkFamilyCoverage = realCheckFamilyCoverage,
}: PreviewPaneProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [coverageStatus, setCoverageStatus] = useState<CoverageStatus>("ok");
  const resolvedData = data ?? DEFAULT_SAMPLE_DATA;

  const widthPx = spec.widthMm * scale;
  const heightPx = spec.heightMm * scale;

  // Draw effect: schematic paint + real-rasterizer compositing. No-ops
  // under jsdom (no real 2D context) -- see this module's doc comment.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    draw(spec, ctx, scale, resolvedData);

    let cancelled = false;
    async function compositeRaster() {
      for (const element of elementsNeedingRaster(spec, resolvedData)) {
        const text = resolvedTextOf(element, resolvedData);
        try {
          const fontSizePx = ptToDots(element.fontSizePt, spec.dpi);
          const raster = await rasterizeText(text, {
            fontFamily: PREVIEW_FONT_FAMILY,
            fontSizePx,
            bold: element.bold ?? false,
          });
          if (cancelled) return;

          const offscreen = document.createElement("canvas");
          offscreen.width = raster.width;
          offscreen.height = raster.height;
          const offCtx = offscreen.getContext("2d");
          if (!offCtx) continue;
          const rgba = decodeRasterToRgba(raster);
          offCtx.putImageData(new ImageData(rgba, raster.width, raster.height), 0, 0);

          const destXPx = element.xMm * scale;
          const destYPx = element.yMm * scale;
          const destWidthPx = dotsToMm(raster.width, spec.dpi) * scale;
          const destHeightPx = dotsToMm(raster.height, spec.dpi) * scale;
          ctx!.drawImage(offscreen, destXPx, destYPx, destWidthPx, destHeightPx);
        } catch {
          // A single element's rasterization failing (e.g. a real browser
          // hitting some font-load edge case) must not blank the whole
          // preview -- it just keeps its schematic `draw()` rendering.
        }
      }
    }
    void compositeRaster();

    return () => {
      cancelled = true;
    };
  }, [spec, scale, resolvedData, rasterizeText]);

  // Coverage-check effect: independent of canvas availability (see this
  // module's doc comment) -- must run, and be assertable, under jsdom too.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (elementsNeedingRaster(spec, resolvedData).length === 0) {
        setCoverageStatus("ok");
        return;
      }
      try {
        const covered = await checkFamilyCoverage(PREVIEW_FONT_FAMILY);
        if (cancelled) return;
        setCoverageStatus(covered ? "ok" : "missing");
      } catch {
        // ANY failure -- network, parse, or an unexpected throw -- surfaces
        // as the honest "could not verify" warning below, never an
        // unhandled rejection (this task brief's explicit requirement).
        if (cancelled) return;
        setCoverageStatus("check-failed");
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [spec, resolvedData, checkFamilyCoverage]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <canvas
        ref={canvasRef}
        width={widthPx}
        height={heightPx}
        style={{
          width: widthPx,
          height: heightPx,
          background: "#ffffff",
          boxShadow: "var(--shadow-2)",
        }}
      />
      <span style={{ font: "400 12px/16px var(--font-mono)", color: "var(--fg-3)" }}>
        {t("pages.labels.editor.preview.caption")}
      </span>
      {coverageStatus === "missing" && (
        <Alert tone="warn">{t("pages.labels.editor.preview.cyrillicWarning")}</Alert>
      )}
      {coverageStatus === "check-failed" && (
        <Alert tone="warn">{t("pages.labels.editor.preview.coverageCheckFailed")}</Alert>
      )}
    </div>
  );
}
