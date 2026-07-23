/**
 * Plan 04 Task 8: label template library screen -- per-card thumbnail.
 *
 * Reuses Task 9's shared renderer (`editor/renderer.ts`'s `draw`) at a small
 * scale, with deterministic `sampleLabelData()` (same sample source Task
 * 10's live preview will use) so cards show plausible content instead of
 * raw `{field}` placeholders. See `api.ts`'s `useLabelTemplate` doc comment
 * for why this fetches its own template lazily rather than the library
 * screen fetching every full spec up front.
 *
 * JSDOM NOTE (mirrors `LabelCanvas.tsx`/`renderer.ts`'s identical
 * constraint): `HTMLCanvasElement.prototype.getContext("2d")` returns
 * `null` under jsdom (no native `canvas` backend installed), so `draw` is
 * simply skipped there -- this component renders a normal (empty) canvas
 * element instead of throwing.
 */
import { useEffect, useRef } from "react";

import { sampleLabelData } from "@markiro/domain";

import { draw } from "./editor/renderer.js";
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

  // Redraws on every render (no dependency array) -- same rationale as
  // `LabelCanvas.tsx`: a plain imperative paint surface with no internal
  // state, cheap to repaint unconditionally, and this sidesteps having to
  // depend on a fresh `sampleLabelData()` object identity.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    draw(data.spec, ctx, scale, sampleLabelData());
  });

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
