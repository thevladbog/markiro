import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { LabelTemplateSpec } from "@markiro/domain";

import {
  compositeTextRasters,
  drawLabel,
  paintCodeRasters,
} from "../../office/templates/label-renderer.js";
import { useLabelRendering } from "../../office/templates/label-rendering.js";
import { labelRenderOptions } from "../../office/templates/label-samples.js";
import type { LabelFields } from "../print/label-render.js";

/** Pixels per millimetre: a 58×40 label is 464×320 px, a 100×150 one 800×1200 (CSS fits it). */
const SCALE = 8;

export interface DemoLabelPreviewProps {
  spec: LabelTemplateSpec;
  purpose: "box" | "pallet";
  /** The job's own fields: the label as it would have been printed. */
  fields: LabelFields;
}

/**
 * A demo shift's label on the screen instead of a printer (spec 2026-10-21, decision Д2): the
 * job's fields drawn by the office preview's renderer, the one the print shares («предпросмотр =
 * печать»). Where the webview gives no canvas the frame stays empty.
 */
export function DemoLabelPreview({ spec, purpose, fields }: DemoLabelPreviewProps) {
  const { t } = useTranslation();
  const { context, rasterizeText } = useLabelRendering();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const drawing = canvas === null ? null : context(canvas);
    if (drawing === null) return undefined;
    const options = labelRenderOptions(purpose);
    drawLabel(spec, drawing, SCALE, fields, options);
    let cancelled = false;
    const isCancelled = () => cancelled;
    void paintCodeRasters(spec, drawing, SCALE, fields, options, isCancelled).then(() =>
      compositeTextRasters(spec, drawing, SCALE, fields, options, rasterizeText, isCancelled),
    );
    return () => {
      cancelled = true;
    };
  }, [spec, purpose, fields, context, rasterizeText]);

  return (
    <canvas
      ref={canvasRef}
      className="demo-label-preview"
      role="img"
      aria-label={t("floor.demo.preview.image", { width: spec.widthMm, height: spec.heightMm })}
      width={Math.round(spec.widthMm * SCALE)}
      height={Math.round(spec.heightMm * SCALE)}
    />
  );
}
