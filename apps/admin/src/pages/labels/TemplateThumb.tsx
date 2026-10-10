/**
 * Plan 04 Task 8: label template library screen -- per-card thumbnail.
 *
 * Reuses the shared renderer (`./renderer.ts`'s `draw`) at a small
 * scale, with deterministic `sampleLabelData()` (same sample source Task
 * 10's live preview will use) so cards show plausible content instead of
 * raw `{field}` placeholders. See `api.ts`'s `useLabelTemplate` doc comment
 * for why this fetches its own template lazily rather than the library
 * screen fetching every full spec up front.
 *
 * JSDOM NOTE (mirrors `renderer.ts`'s identical
 * constraint): `HTMLCanvasElement.prototype.getContext("2d")` returns
 * `null` under jsdom (no native `canvas` backend installed), so `draw` is
 * simply skipped there -- this component renders a normal (empty) canvas
 * element instead of throwing.
 */
import { isPalletSheetSpec } from "@markiro/domain";
import { useEffect, useRef } from "react";

import { rasterizeText } from "../../labels/rasterizer.js";
import {
  renderSheetPreview,
  previewSheetContext,
  paintSheetRaster,
} from "./editor/sheet/sheet-preview.js";
import { loadCabinetSheetBranding } from "./editor/sheet/sheet-branding.js";
import { labelPreviewData, labelRenderOptions } from "./preview-data.js";

import { draw } from "./renderer.js";
import { useLabelTemplate } from "./api.js";

/** Thumbnail track (the shaded box the label preview sits inside), matching
 * the handoff prototype's card thumbnail area (`prototypes/admin-panel.dc.html`,
 * "Этикетки" screen: `height: 130px; background: #F0EFEA`). */
const TRACK_HEIGHT_PX = 130;
const MAX_LABEL_WIDTH_PX = 150;
const MAX_LABEL_HEIGHT_PX = 110;

export interface TemplateThumbProps {
  id: string;
  widthMm: number;
  heightMm: number;
}

export function TemplateThumb({ id, widthMm, heightMm }: TemplateThumbProps) {
  const { data } = useLabelTemplate(id);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Fit the label's own aspect ratio inside a fixed-size track, same
  // "letterbox to the smaller axis" approach as any thumbnail preview.
  const scale = Math.min(MAX_LABEL_WIDTH_PX / widthMm, MAX_LABEL_HEIGHT_PX / heightMm);
  const widthPx = widthMm * scale;
  const heightPx = heightMm * scale;

  // Redraws on every render (no dependency array): a plain imperative paint
  // surface with no internal state, cheap to repaint unconditionally, and
  // this sidesteps having to depend on a fresh `sampleLabelData()` object
  // identity.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (isPalletSheetSpec(data.spec)) {
      let cancelled = false;
      const spec = data.spec;
      void loadCabinetSheetBranding()
        .then((branding) =>
          renderSheetPreview(
            spec,
            {
              ...previewSheetContext(
                { date: true, egais: true, longName: false, maximumCounts: false },
                branding.logo,
              ),
              organizationName: branding.organizationName,
            },
            rasterizeText,
          ),
        )
        .then((raster) => {
          if (!cancelled) paintSheetRaster(canvas, raster);
        })
        .catch(() => {
          if (!cancelled) ctx.clearRect(0, 0, canvas.width, canvas.height);
        });
      return () => {
        cancelled = true;
      };
    }
    draw(data.spec, ctx, scale, labelPreviewData(data.purpose), labelRenderOptions(data.purpose));
  }, [data, scale]);

  return (
    <div
      style={{
        height: TRACK_HEIGHT_PX,
        background: "var(--surface-panel)",
        borderRadius: "var(--r-2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <canvas
        ref={canvasRef}
        width={widthPx}
        height={heightPx}
        style={{
          width: widthPx,
          height: heightPx,
          background: "#ffffff",
          border: "1px solid var(--line-strong)",
        }}
      />
    </div>
  );
}
