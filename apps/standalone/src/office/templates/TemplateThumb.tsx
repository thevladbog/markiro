import { useEffect, useMemo, useRef, useState } from "react";

import type { LabelTemplateSummary } from "../../host/protocol.js";
import { useTemplateLayout } from "../catalog-queries.js";
import { readSpec } from "./editor-model.js";
import { drawLabel, paintCodeRasters } from "./label-renderer.js";
import { useLabelRendering } from "./label-rendering.js";
import { labelRenderOptions, labelSampleData } from "./label-samples.js";

/** The box a thumbnail sits in; the label keeps its own proportions inside it. */
const BOX_WIDTH_PX = 64;
const BOX_HEIGHT_PX = 48;

/**
 * A row's thumbnail on «Шаблоны», after the cloud's `TemplateThumb`: the
 * layout is read only once the row comes on screen (`whenVisible`), and kept
 * by id and revision (`useTemplateLayout`), so the list's summaries never
 * hold a layout. It is drawn with the purpose's sample data; until then, and
 * for a layout that does not load or does not read, the box stays empty. It
 * is decorative: the name beside it says what it is, so assistive technology
 * skips it (`aria-hidden`).
 */
export function TemplateThumb({ template }: { template: LabelTemplateSummary }) {
  const { context, whenVisible } = useLabelRendering();
  const frame = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const layout = useTemplateLayout(template, visible);
  const spec = useMemo(
    () => (layout.data === undefined ? null : readSpec(layout.data.spec)),
    [layout.data],
  );
  const scale =
    spec === null ? 0 : Math.min(BOX_WIDTH_PX / spec.widthMm, BOX_HEIGHT_PX / spec.heightMm);

  useEffect(() => {
    const element = frame.current;
    if (element === null || visible) return undefined;
    return whenVisible(element, () => setVisible(true));
  }, [whenVisible, visible]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const drawing = canvas === null || spec === null ? null : context(canvas);
    if (drawing === null || spec === null) return undefined;
    const data = labelSampleData(template.purpose);
    const options = labelRenderOptions(template.purpose);
    drawLabel(spec, drawing, scale, data, options);
    let cancelled = false;
    void paintCodeRasters(spec, drawing, scale, data, options, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [context, spec, scale, template.purpose]);

  return (
    <span ref={frame} className="template-thumb" aria-hidden="true">
      {spec !== null && (
        <canvas
          ref={canvasRef}
          className="template-thumb__label"
          width={Math.round(spec.widthMm * scale)}
          height={Math.round(spec.heightMm * scale)}
        />
      )}
    </span>
  );
}
