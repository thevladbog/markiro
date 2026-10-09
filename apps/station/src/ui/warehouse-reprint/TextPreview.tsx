import { labelRasterSvgPath, type LabelRenderElement } from "@markiro/domain";

/** A view of the domain's resolved print bitmap, with no second text layout. */
export function TextPreview({
  element,
  dpi,
}: {
  element: Extract<LabelRenderElement, { kind: "raster" }>;
  dpi: number;
}) {
  return (
    <g
      data-raster-element={element.id}
      data-x-mm={(element.xDots * 25.4) / dpi}
      aria-label={element.text}
      transform={`translate(${element.xDots} ${element.yDots})`}
    >
      <rect width={element.raster.width} height={element.raster.height} fill="white" />
      <path d={labelRasterSvgPath(element.raster)} fill="black" />
    </g>
  );
}
