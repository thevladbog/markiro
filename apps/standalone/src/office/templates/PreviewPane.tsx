import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LabelTemplateSpec, MonoBitmap } from "@markiro/domain";
import { Alert } from "@markiro/ui";

import type { TemplatePurpose } from "../../host/protocol.js";
import type { LabelFontFamily } from "../../labels/font-coverage.js";
import {
  compositeTextRasters,
  drawLabel,
  paintCodeRasters,
  rasterTextElements,
} from "./label-renderer.js";
import { useLabelRendering } from "./label-rendering.js";
import { labelRenderOptions, labelSampleData } from "./label-samples.js";
import { sizeText } from "./template-text.js";

/** Pixels per millimetre of the preview: a 58 mm label is 174 px wide. */
const SCALE = 3;

/** The face the print's bitmaps are drawn in (`mapFontFamily` of the generators' «sans-serif»). */
const PREVIEW_FONT_FAMILY: LabelFontFamily = "IBM Plex Sans";

type Coverage = "ok" | "missing" | "failed";

export interface PreviewPaneProps {
  spec: LabelTemplateSpec;
  purpose: TemplatePurpose;
  /**
   * What an `organization_logo` box draws (#703): the editor gives the logo a
   * new shift would print (`useLabelLogo`); none — the box stays white.
   */
  logo?: MonoBitmap | null;
}

/**
 * The layout as it prints, after the cloud's `PreviewPane`: drawn with the
 * purpose's sample data (`labelSampleData`) and drawn again whenever the
 * layout changes, a duplicate's code painted as the station's raster
 * (`paintCodeRasters`) and the print's own bitmaps put over its Cyrillic text
 * (`compositeTextRasters`), and a warning when the font lacks Cyrillic or
 * could not be checked. The check runs only while the layout has such text;
 * it needs no canvas, so a webview without one still says it. A warning is
 * the answer of the check that is running: it goes when that check ends, and
 * a later check shows its own answer only once it has one.
 */
export function PreviewPane({ spec, purpose, logo = null }: PreviewPaneProps) {
  const { t } = useTranslation();
  const { context, rasterizeText, checkFamilyCoverage } = useLabelRendering();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [coverage, setCoverage] = useState<Coverage>("ok");
  const data = labelSampleData(purpose);
  const options = useMemo(() => ({ ...labelRenderOptions(purpose), logo }), [purpose, logo]);
  const needsCheck = rasterTextElements(spec, data).length > 0;

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

  useEffect(() => {
    if (!needsCheck) return undefined;
    let cancelled = false;
    checkFamilyCoverage(PREVIEW_FONT_FAMILY).then(
      (covered) => {
        if (!cancelled) setCoverage(covered ? "ok" : "missing");
      },
      () => {
        if (!cancelled) setCoverage("failed");
      },
    );
    return () => {
      cancelled = true;
      // The verdict belongs to the check that produced it: when that check
      // ends (the layout lost its Cyrillic text), it is not shown again for a
      // later one before that one answers.
      setCoverage("ok");
    };
  }, [needsCheck, checkFamilyCoverage]);

  const shown = needsCheck ? coverage : "ok";
  return (
    <figure className="template-preview">
      <canvas
        ref={canvasRef}
        className="template-preview__label"
        role="img"
        aria-label={t("office.templateEditor.preview.label", { size: sizeText(spec, t) })}
        width={Math.round(spec.widthMm * SCALE)}
        height={Math.round(spec.heightMm * SCALE)}
      />
      <figcaption className="office-note">
        {t("office.templateEditor.preview.caption", { scale: SCALE })}
      </figcaption>
      {purpose === "product_duplicate" && (
        <p className="office-note">{t("office.templateEditor.preview.sample")}</p>
      )}
      {shown === "missing" && (
        <Alert tone="warn">{t("office.templateEditor.preview.missingGlyphs")}</Alert>
      )}
      {shown === "failed" && (
        <Alert tone="warn">{t("office.templateEditor.preview.checkFailed")}</Alert>
      )}
    </figure>
  );
}
