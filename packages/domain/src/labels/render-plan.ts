import bwipjs from "bwip-js/generic";
import { DomainError } from "../errors.js";
import { rasterizeGs1DataMatrix } from "../barcodes/gs1-data-matrix.js";
import { renderCode128Svg, renderLiteralDataMatrixSvg } from "../barcodes/svg.js";
import { code128ModuleCount, EAN13_MODULES } from "./code128.js";
import {
  labelFieldDisplayValue,
  mmToDots,
  ptToDots,
  type LabelBarcodeElement,
  type LabelField,
  type LabelTemplateSpec,
  type PrinterDpi,
} from "./model.js";
import {
  buildBitmapCommand,
  buildGfaCommand,
  rasterAlignOffsetDots,
  type RasterResult,
  type RasterizeTextFn,
} from "./raster-types.js";
import {
  buildTsplBar,
  buildTsplBox,
  buildTsplDocument,
  buildZplBox,
  buildZplDocument,
} from "./printer-commands.js";
import { renderTsplBarcodeElement } from "./tspl.js";
import { renderZplBarcodeElement } from "./zpl.js";

type Position = { id: string; xDots: number; yDots: number };
export type LabelRenderElement =
  | (Position & { kind: "raster"; text: string; raster: RasterResult })
  | (Position & {
      kind: "barcode";
      element: LabelBarcodeElement;
      value: string;
      gs1: boolean;
      svg: string;
      widthDots: number;
      heightDots: number;
    })
  | (Position & {
      kind: "rectangle";
      widthDots: number;
      heightDots: number;
      thicknessDots: number;
      filled: boolean;
    });
export interface LabelRenderPlan {
  language: LabelTemplateSpec["language"];
  dpi: PrinterDpi;
  widthMm: number;
  heightMm: number;
  widthDots: number;
  heightDots: number;
  fields: Record<LabelField, string>;
  elements: LabelRenderElement[];
}

/** Opt-in warehouse rendering. All text uses the supplied bounded font raster,
 * including ASCII, avoiding printer-native font and wrapping approximations.
 * Existing production emitters and previously frozen bytes are unaffected. */
export async function createLabelRenderPlan(
  spec: LabelTemplateSpec,
  fields: Record<LabelField, string>,
  destination: {
    language: LabelTemplateSpec["language"];
    dpi: PrinterDpi;
    rasterizeText: RasterizeTextFn;
  },
): Promise<LabelRenderPlan> {
  const { dpi, language, rasterizeText } = destination;
  const data = { ...fields };
  const elements: LabelRenderElement[] = [];
  const toMm = (dots: number) => (dots * 25.4) / dpi;
  for (const element of spec.elements) {
    const position = {
      id: element.id,
      xDots: mmToDots(element.xMm, dpi),
      yDots: mmToDots(element.yMm, dpi),
    };
    if (element.kind === "text" || element.kind === "field") {
      const text =
        element.kind === "text"
          ? element.text
          : labelFieldDisplayValue(element.field, data, element.textFormat);
      const maxWidthPx =
        element.maxWidthMm === undefined ? undefined : mmToDots(element.maxWidthMm, dpi);
      const raster = await rasterizeText(text, {
        fontFamily: "sans-serif",
        fontSizePx: ptToDots(element.fontSizePt, dpi),
        bold: element.bold ?? false,
        maxWidthPx,
        maxLines: element.maxLines ?? 1,
      });
      elements.push({
        ...position,
        xDots: position.xDots + rasterAlignOffsetDots(element.align, maxWidthPx, raster.width),
        kind: "raster",
        text,
        raster,
      });
    } else if (element.kind === "barcode") {
      const value = typeof element.data === "string" ? data[element.data] : element.data.literal;
      if (element.format === "datamatrix" && element.data === "km.code") {
        elements.push({
          ...position,
          kind: "raster",
          text: value,
          raster: rasterizeGs1DataMatrix(value, mmToDots(element.sizeMm, dpi)),
        });
        continue;
      }
      const gs1 = element.format === "code128" && element.data === "sscc";
      const sizeDots = mmToDots(element.sizeMm, dpi);
      const moduleDots =
        element.format === "qr"
          ? Math.max(1, Math.min(10, sizeDots))
          : element.moduleWidthMm === undefined
            ? 2
            : Math.max(
                1,
                language === "zpl"
                  ? Math.min(10, mmToDots(element.moduleWidthMm, dpi))
                  : mmToDots(element.moduleWidthMm, dpi),
              );
      // Pin even unspecified linear modules for new warehouse labels so preview
      // geometry never depends on a previous ZPL format's modal ^BY setting.
      const resolvedElement: LabelBarcodeElement = {
        ...element,
        xMm: toMm(position.xDots),
        yMm: toMm(position.yDots),
        sizeMm: toMm(sizeDots),
        ...(element.format === "code128" || element.format === "ean13"
          ? { moduleWidthMm: toMm(moduleDots) }
          : {}),
      };
      let svg: string;
      let widthDots: number;
      let heightDots = sizeDots;
      if (element.format === "code128") {
        svg = renderCode128Svg(gs1 ? `(00)${value}` : value, { includeText: false, gs1 });
        widthDots = code128ModuleCount(gs1 ? `00${value}` : value, gs1) * moduleDots;
      } else if (element.format === "ean13") {
        svg = bwipjs.toSVG({ bcid: "ean13", text: value, scale: 2, includetext: false });
        widthDots = EAN13_MODULES * moduleDots;
      } else {
        const format = element.format;
        const encoding = {
          bcid: format === "qr" ? "qrcode" : "datamatrix",
          text: value,
          ...(format === "qr"
            ? { eclevel: language === "zpl" ? "Q" : "M", fixedeclevel: true }
            : {}),
        };
        svg =
          format === "qr"
            ? bwipjs.toSVG({ ...encoding, scale: 3 })
            : renderLiteralDataMatrixSvg(value);
        const symbol = bwipjs.raw(encoding)[0];
        if (!symbol || !("pixx" in symbol))
          throw new DomainError("LABEL_ENCODING_FAILED", "Unexpected barcode geometry");
        widthDots =
          format === "datamatrix" && language === "tspl"
            ? sizeDots
            : symbol.pixx * (format === "qr" ? moduleDots : sizeDots);
        heightDots =
          format === "datamatrix" && language === "tspl"
            ? sizeDots
            : symbol.pixy * (format === "qr" ? moduleDots : sizeDots);
      }
      elements.push({
        ...position,
        kind: "barcode",
        element: resolvedElement,
        value,
        gs1,
        svg,
        widthDots,
        heightDots,
      });
    } else {
      const thicknessDots = mmToDots(element.thicknessMm, dpi);
      elements.push(
        element.kind === "box"
          ? {
              ...position,
              kind: "rectangle",
              widthDots: mmToDots(element.widthMm, dpi),
              heightDots: mmToDots(element.heightMm, dpi),
              thicknessDots,
              filled: false,
            }
          : {
              ...position,
              kind: "rectangle",
              xDots: mmToDots(Math.min(element.xMm, element.x2Mm), dpi),
              yDots: mmToDots(Math.min(element.yMm, element.y2Mm), dpi),
              widthDots: Math.max(
                mmToDots(Math.abs(element.xMm - element.x2Mm), dpi),
                thicknessDots,
              ),
              heightDots: Math.max(
                mmToDots(Math.abs(element.yMm - element.y2Mm), dpi),
                thicknessDots,
              ),
              thicknessDots,
              filled: true,
            },
      );
    }
  }
  return {
    language,
    dpi,
    widthMm: spec.widthMm,
    heightMm: spec.heightMm,
    widthDots: mmToDots(spec.widthMm, dpi),
    heightDots: mmToDots(spec.heightMm, dpi),
    fields: data,
    elements,
  };
}

/** Serialize the resolved geometry; never resolve fields, wrap, or rasterize again. */
export function emitLabelRenderPlan(plan: LabelRenderPlan): string {
  const zpl = plan.language === "zpl";
  const lines: string[] = [];
  for (const e of plan.elements) {
    if (e.kind === "raster")
      lines.push(
        zpl
          ? `^FO${e.xDots},${e.yDots}${buildGfaCommand(e.raster)}^FS`
          : buildBitmapCommand(e.xDots, e.yDots, e.raster),
      );
    else if (e.kind === "barcode")
      lines.push(
        zpl
          ? renderZplBarcodeElement(e.element, plan.fields, plan.dpi, { ean13IncludeText: false })
          : renderTsplBarcodeElement(e.element, plan.fields, plan.dpi),
      );
    else
      lines.push(
        zpl
          ? buildZplBox(
              e.xDots,
              e.yDots,
              e.widthDots,
              e.heightDots,
              e.filled ? Math.min(e.widthDots, e.heightDots) : e.thicknessDots,
            )
          : e.filled
            ? buildTsplBar(e.xDots, e.yDots, e.widthDots, e.heightDots)
            : buildTsplBox(e.xDots, e.yDots, e.widthDots, e.heightDots, e.thicknessDots),
      );
  }
  return zpl
    ? buildZplDocument(plan.widthDots, plan.heightDots, lines)
    : buildTsplDocument(plan.widthMm, plan.heightMm, lines);
}

/** Same padded, MSB-first pixels supplied to both print serializers. */
export function labelRasterSvgPath(raster: RasterResult): string {
  const bytes = Array.from({ length: raster.totalBytes }, (_, i) =>
    Number.parseInt(raster.hex.slice(i * 2, i * 2 + 2), 16),
  );
  const black = (x: number, y: number) =>
    ((bytes[y * raster.bytesPerRow + (x >> 3)] ?? 0) & (1 << (7 - (x % 8)))) !== 0;
  const runs: string[] = [];
  for (let y = 0; y < raster.height; y++)
    for (let x = 0; x < raster.width;) {
      if (!black(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < raster.width && black(x, y)) x++;
      const width = x - start;
      runs.push(`M${start} ${y}h${width}v1h-${width}z`);
    }
  return runs.join("");
}
