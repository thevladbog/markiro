import { useEffect, useMemo, useState } from "react";
import {
  estimatedTextWidthMm,
  LINE_HEIGHT_EM,
  mmToDots,
  needsImageRendering,
  ptToDots,
  ptToMm,
  rasterAlignOffsetDots,
  wrapTextToWidth,
  type LabelFieldElement,
  type LabelTextElement,
  type PrinterDpi,
  type RasterResult,
} from "@markiro/domain";
import { rasterizeText } from "../../lib/rasterizer.js";

type TextElement = LabelTextElement | LabelFieldElement;

/** Draws the same byte-padded, MSB-first pixels supplied to the print emitters. */
function rasterPath(raster: RasterResult): string {
  const bytes = Array.from({ length: raster.totalBytes }, (_, i) =>
    Number.parseInt(raster.hex.slice(i * 2, i * 2 + 2), 16),
  );
  const black = (x: number, y: number) =>
    ((bytes[y * raster.bytesPerRow + (x >> 3)] ?? 0) & (1 << (7 - (x % 8)))) !== 0;
  const runs: string[] = [];
  for (let y = 0; y < raster.height; y++) {
    let x = 0;
    while (x < raster.width) {
      if (!black(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < raster.width && black(x, y)) x++;
      const width = x - start;
      runs.push(`M${start} ${y}h${width}v1h-${width}z`);
    }
  }
  return runs.join("");
}

export function TextPreview({
  element,
  text,
  dpi,
}: {
  element: TextElement;
  text: string;
  dpi: PrinterDpi;
}) {
  const [loaded, setLoaded] = useState<{
    element: TextElement;
    text: string;
    dpi: PrinterDpi;
    raster: RasterResult;
  } | null>(null);
  const rasterRequired = needsImageRendering(text);
  useEffect(() => {
    if (!rasterRequired) return;
    let active = true;
    void rasterizeText(text, {
      fontFamily: "sans-serif",
      fontSizePx: ptToDots(element.fontSizePt, dpi),
      bold: element.bold ?? false,
      ...(element.maxWidthMm === undefined
        ? {}
        : { maxWidthPx: mmToDots(element.maxWidthMm, dpi) }),
      maxLines: element.maxLines ?? 1,
    })
      .then((raster) => {
        if (active) setLoaded({ element, text, dpi, raster });
      })
      .catch(() => {
        /* Keep the bounded schematic if canvas rendering is unavailable. */
      });
    return () => {
      active = false;
    };
  }, [element, text, dpi, rasterRequired]);
  const raster =
    rasterRequired && loaded?.element === element && loaded.text === text && loaded.dpi === dpi
      ? loaded.raster
      : null;
  const pixels = useMemo(() => (raster ? rasterPath(raster) : null), [raster]);
  if (raster && pixels !== null) {
    const maxWidth =
      element.maxWidthMm === undefined ? undefined : mmToDots(element.maxWidthMm, dpi);
    const x =
      ((mmToDots(element.xMm, dpi) + rasterAlignOffsetDots(element.align, maxWidth, raster.width)) *
        25.4) /
      dpi;
    const y = (mmToDots(element.yMm, dpi) * 25.4) / dpi;
    return (
      <g
        data-raster-element={element.id}
        data-x-mm={x}
        aria-label={text}
        transform={`translate(${x} ${y}) scale(${25.4 / dpi})`}
      >
        <rect width={raster.width} height={raster.height} fill="white" />
        <path d={pixels} fill="black" />
      </g>
    );
  }
  const width = element.maxWidthMm;
  const align = width === undefined ? "left" : (element.align ?? "left");
  const x =
    element.xMm +
    (width === undefined || align === "left" ? 0 : align === "center" ? width / 2 : width);
  const lines =
    width === undefined
      ? [text]
      : wrapTextToWidth(
          text,
          (s) => estimatedTextWidthMm(s, element.fontSizePt),
          width,
          element.maxLines ?? 1,
        );
  return (
    <text
      x={x}
      y={element.yMm}
      textAnchor={align === "center" ? "middle" : align === "right" ? "end" : "start"}
      dominantBaseline="hanging"
      fontFamily="IBM Plex Sans, sans-serif"
      fontSize={ptToMm(element.fontSizePt)}
      fontWeight={element.bold ? 700 : 400}
      fill="black"
    >
      {lines.map((line, index) => (
        <tspan
          key={index}
          x={x}
          y={element.yMm + index * ptToMm(element.fontSizePt) * LINE_HEIGHT_EM}
        >
          {line}
        </tspan>
      ))}
    </text>
  );
}
