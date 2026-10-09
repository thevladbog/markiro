import { useEffect, useState } from "react";
import {
  createLabelRenderPlan,
  sampleLabelData,
  type LabelRenderPlan,
  type WarehouseTemplate,
  type PrinterDpi,
  type LabelTemplateSpec,
} from "@markiro/domain";
import { TextPreview } from "./TextPreview.js";
import { rasterizeText } from "../../lib/rasterizer.js";
import { useTranslation } from "react-i18next";
export function LabelPreview({
  template,
  dpi = template.spec.dpi,
  language = template.spec.language,
}: {
  template: WarehouseTemplate;
  dpi?: PrinterDpi;
  language?: LabelTemplateSpec["language"];
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{
    template: WarehouseTemplate;
    dpi: PrinterDpi;
    language: LabelTemplateSpec["language"];
    plan: LabelRenderPlan | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void createLabelRenderPlan(
      template.spec,
      { ...sampleLabelData(), "km.code": `${sampleLabelData()["km.code"]}\u001d93DEMO` },
      { dpi, language, rasterizeText },
    )
      .then((plan) => {
        if (active) setLoaded({ template, dpi, language, plan });
      })
      .catch(() => {
        if (active) setLoaded({ template, dpi, language, plan: null });
      });
    return () => {
      active = false;
    };
  }, [template, dpi, language]);
  const current =
    loaded?.template === template && loaded.dpi === dpi && loaded.language === language;
  const plan = current ? loaded.plan : null;
  const spec = template.spec;
  return (
    <figure className="warehouse-label-preview">
      {plan ? (
        <svg
          role="img"
          aria-label={t("warehouse.previewLabel", { name: template.name })}
          viewBox={`0 0 ${plan.widthDots} ${plan.heightDots}`}
          data-language={plan.language}
          data-dpi={plan.dpi}
        >
          <rect width={plan.widthDots} height={plan.heightDots} fill="white" />
          {plan.elements.map((e) =>
            e.kind === "raster" ? (
              <TextPreview key={e.id} element={e} dpi={plan.dpi} />
            ) : e.kind === "barcode" ? (
              <image
                key={e.id}
                data-barcode-element={e.id}
                x={e.xDots}
                y={e.yDots}
                width={e.widthDots}
                height={e.heightDots}
                href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(e.svg)}`}
                preserveAspectRatio="none"
              />
            ) : (
              <rect
                key={e.id}
                x={e.xDots + (e.filled ? 0 : e.thicknessDots / 2)}
                y={e.yDots + (e.filled ? 0 : e.thicknessDots / 2)}
                width={e.widthDots - (e.filled ? 0 : e.thicknessDots)}
                height={e.heightDots - (e.filled ? 0 : e.thicknessDots)}
                fill={e.filled ? "black" : "none"}
                stroke={e.filled ? "none" : "black"}
                strokeWidth={e.thicknessDots}
              />
            ),
          )}
        </svg>
      ) : (
        <p role="status">
          {t(current ? "warehouse.previewUnavailable" : "warehouse.previewLoading")}
        </p>
      )}
      <figcaption>
        {t("warehouse.previewSample")} · {spec.widthMm} × {spec.heightMm} {t("warehouse.mm")}
      </figcaption>
    </figure>
  );
}
