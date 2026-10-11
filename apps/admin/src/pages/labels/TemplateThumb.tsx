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
import { isPalletSheetSpec, type PalletSheetSpecV2 } from "@markiro/domain";
import { useEffect, useRef } from "react";

import { labelPreviewData, labelRenderOptions } from "./preview-data.js";

import { draw } from "./renderer.js";
import { useLabelTemplate } from "./api.js";

/** Thumbnail track (the shaded box the label preview sits inside), matching
 * the handoff prototype's card thumbnail area (`prototypes/admin-panel.dc.html`,
 * "Этикетки" screen: `height: 130px; background: #F0EFEA`). */
const TRACK_HEIGHT_PX = 130;
const MAX_LABEL_WIDTH_PX = 150;
const MAX_LABEL_HEIGHT_PX = 110;

/** Library overview only; the editor and print dialog provide the exact shared-renderer preview. */
function drawSheetThumbnail(
  ctx: CanvasRenderingContext2D,
  spec: PalletSheetSpecV2,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const cell = width / spec.page.copies;
  for (let copy = 0; copy < spec.page.copies; copy++) {
    const left = cell * copy + cell * 0.08,
      contentWidth = cell * 0.84;
    ctx.fillStyle = "#b0b0b0";
    ctx.fillRect(left, height * 0.08, contentWidth * 0.35, height * 0.07);
    for (let line = 0; line < 4; line++)
      ctx.fillRect(
        left,
        height * (0.23 + line * 0.1),
        contentWidth * (line === 0 ? 1 : 0.75),
        height * 0.025,
      );
    ctx.fillStyle = "#303030";
    ctx.fillRect(left, height * 0.76, contentWidth, height * 0.15);
  }
  if (spec.page.cutLine) {
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(cell, 0);
    ctx.lineTo(cell, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

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

  // A4 cards show a bounded schematic; full print rendering belongs to the editor/print preview.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (isPalletSheetSpec(data.spec)) {
      drawSheetThumbnail(ctx, data.spec, canvas.width, canvas.height);
      return;
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
