import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { LabelField, LabelTemplateSpec } from "@markiro/domain";

import type { TemplatePurpose } from "../../host/protocol.js";
import {
  compositeTextRasters,
  drawLabel,
  paintCodeRasters,
} from "../../office/templates/label-renderer.js";
import { useLabelRendering } from "../../office/templates/label-rendering.js";
import { labelRenderOptions, labelSampleData } from "../../office/templates/label-samples.js";

/** Pixels per millimetre the preview is drawn at; CSS fits it to its column. */
const SCALE = 4;

export interface TemplatePreviewProps {
  spec: LabelTemplateSpec;
  purpose: Extract<TemplatePurpose, "box" | "pallet">;
  /** The product of the new shift: its name and GTIN replace the sample's. */
  product: { name: string; gtin14: string };
}

/**
 * The label a template prints, beside its choice in a new shift (the cloud
 * station's `LabelPreview` in `NewShift`'s template step): drawn as the
 * office's preview draws it (`label-renderer`), with the purpose's sample
 * data and the shift's product put in, so the operator sees the layout, not
 * a print. Where the webview gives no canvas the box stays empty.
 */
export function TemplatePreview({ spec, purpose, product }: TemplatePreviewProps) {
  const { t } = useTranslation();
  const { context, rasterizeText } = useLabelRendering();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const data = useMemo<Record<LabelField, string>>(
    () => ({
      ...labelSampleData(purpose),
      "product.name": product.name,
      "product.printName": product.name,
      "product.gtin": product.gtin14,
    }),
    [purpose, product.gtin14, product.name],
  );
  const options = useMemo(() => labelRenderOptions(purpose), [purpose]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const drawing = canvas === null ? null : context(canvas);
    if (drawing === null) return undefined;
    drawLabel(spec, drawing, SCALE, data, options);
    let cancelled = false;
    const isCancelled = () => cancelled;
    void paintCodeRasters(spec, drawing, SCALE, data, options, isCancelled).then(() =>
      compositeTextRasters(spec, drawing, SCALE, data, options, rasterizeText, isCancelled),
    );
    return () => {
      cancelled = true;
    };
  }, [spec, data, options, context, rasterizeText]);

  return (
    <canvas
      ref={canvasRef}
      className="new-shift__preview-label"
      role="img"
      aria-label={t("floor.newShift.preview", {
        width: spec.widthMm,
        height: spec.heightMm,
      })}
      width={Math.round(spec.widthMm * SCALE)}
      height={Math.round(spec.heightMm * SCALE)}
    />
  );
}
