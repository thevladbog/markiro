import {
  elementBoundsMm,
  labelFieldDisplayValue,
  renderCode128Svg,
  renderDataMatrixSvg,
  renderLiteralDataMatrixSvg,
  renderQrSvg,
  sampleLabelData,
  type WarehouseTemplate,
  type PrinterDpi,
} from "@markiro/domain";
import { TextPreview } from "./TextPreview.js";
import { useTranslation } from "react-i18next";
export function LabelPreview({
  template,
  dpi = template.spec.dpi,
}: {
  template: WarehouseTemplate;
  dpi?: PrinterDpi;
}) {
  const { t } = useTranslation();
  const spec = template.spec;
  const fields = sampleLabelData();
  return (
    <figure className="warehouse-label-preview">
      <svg
        role="img"
        aria-label={t("warehouse.previewLabel", { name: template.name })}
        viewBox={`0 0 ${spec.widthMm} ${spec.heightMm}`}
      >
        <rect width={spec.widthMm} height={spec.heightMm} fill="white" />
        {spec.elements.map((e) => {
          if (e.kind === "text" || e.kind === "field")
            return (
              <TextPreview
                key={e.id}
                element={e}
                dpi={dpi}
                text={
                  e.kind === "text" ? e.text : labelFieldDisplayValue(e.field, fields, e.textFormat)
                }
              />
            );
          if (e.kind === "line")
            return (
              <line
                key={e.id}
                x1={e.xMm}
                y1={e.yMm}
                x2={e.x2Mm}
                y2={e.y2Mm}
                stroke="black"
                strokeWidth={e.thicknessMm}
              />
            );
          if (e.kind === "box")
            return (
              <rect
                key={e.id}
                x={e.xMm}
                y={e.yMm}
                width={e.widthMm}
                height={e.heightMm}
                fill="none"
                stroke="black"
                strokeWidth={e.thicknessMm}
              />
            );
          const data = typeof e.data === "string" ? fields[e.data] : e.data.literal;
          let svg: string;
          try {
            svg =
              e.format === "datamatrix"
                ? e.data === "km.code"
                  ? renderDataMatrixSvg(data)
                  : renderLiteralDataMatrixSvg(data)
                : e.format === "qr"
                  ? renderQrSvg(data)
                  : renderCode128Svg(e.data === "sscc" ? `(00)${data}` : data, {
                      includeText: false,
                      gs1: e.data === "sscc",
                    });
          } catch {
            return null;
          }
          const bounds = elementBoundsMm(e, fields, { kmDataMatrix: "raster" });
          return (
            <image
              key={e.id}
              x={e.xMm}
              y={e.yMm}
              width={bounds.w}
              height={e.sizeMm}
              href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
              preserveAspectRatio="none"
            />
          );
        })}
      </svg>
      <figcaption>
        {t("warehouse.previewSample")} · {spec.widthMm} × {spec.heightMm} {t("warehouse.mm")}
      </figcaption>
    </figure>
  );
}
