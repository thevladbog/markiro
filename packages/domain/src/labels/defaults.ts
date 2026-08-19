import type { LabelTemplateSpec } from "./model.js";

/** One stock template: seed name (the idempotency key) + its spec. */
export interface DefaultLabelTemplate {
  name: string;
  spec: LabelTemplateSpec;
}

/** The stock template new tenants get as their default box label. */
export const DEFAULT_BOX_LABEL_TEMPLATE_NAME = "Коробка 58×40 (203 dpi)";

const BASE_WIDTH_MM = 58;
const BASE_HEIGHT_MM = 40;

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function pt(base: number, scale: number): number {
  return Math.min(72, Math.max(4, Math.round(base * scale)));
}

/**
 * The approved mock-up layout (58×40 base), scaled uniformly to the target
 * size and anchored top-left. Separator lines and the three-column block use
 * the label's ACTUAL width, so wide labels don't leave a dead right margin.
 * Larger sizes keep the same structure with proportionally larger type.
 */
function buildBoxLabelSpec(widthMm: number, heightMm: number, dpi: 203 | 300): LabelTemplateSpec {
  const s = Math.min(widthMm / BASE_WIDTH_MM, heightMm / BASE_HEIGHT_MM);
  const m = round1(2 * s);
  const right = round1(widthMm - m);
  const contentW = round1(widthMm - 2 * m);
  const colW = round1(contentW / 3);
  const cols = [m, round1(m + colW), round1(m + 2 * colW)];
  const thickness = round1(Math.max(0.2, 0.3 * s));
  const captionPt = pt(5, s);
  const valuePt = pt(8, s);
  const namePt = pt(10, s);
  return {
    widthMm,
    heightMm,
    dpi,
    language: "zpl",
    elements: [
      {
        kind: "field",
        id: "name",
        xMm: m,
        yMm: m,
        field: "product.name",
        fontSizePt: namePt,
        bold: true,
        maxWidthMm: contentW,
      },
      {
        kind: "line",
        id: "sep1",
        xMm: m,
        yMm: round1(13 * s),
        x2Mm: right,
        y2Mm: round1(13 * s),
        thicknessMm: thickness,
      },
      {
        kind: "text",
        id: "cap-date",
        xMm: cols[0]!,
        yMm: round1(14.5 * s),
        text: "Дата производства:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "text",
        id: "cap-expiry",
        xMm: cols[1]!,
        yMm: round1(14.5 * s),
        text: "Годен до:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "text",
        id: "cap-qty",
        xMm: cols[2]!,
        yMm: round1(14.5 * s),
        text: "Кол-во в упаковке:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-date",
        xMm: cols[0]!,
        yMm: round1(18 * s),
        field: "date",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-expiry",
        xMm: cols[1]!,
        yMm: round1(18 * s),
        field: "expiry",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-qty",
        xMm: cols[2]!,
        yMm: round1(18 * s),
        field: "qty",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "line",
        id: "sep2",
        xMm: m,
        yMm: round1(23.5 * s),
        x2Mm: right,
        y2Mm: round1(23.5 * s),
        thicknessMm: thickness,
      },
      {
        kind: "text",
        id: "cap-egais",
        xMm: m,
        yMm: round1(25 * s),
        text: "Код ЕГАИС:",
        fontSizePt: captionPt,
        maxWidthMm: contentW,
      },
      {
        kind: "field",
        id: "val-egais",
        xMm: m,
        yMm: round1(28 * s),
        field: "product.egais",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: contentW,
      },
      {
        kind: "line",
        id: "sep3",
        xMm: m,
        yMm: round1(32.5 * s),
        x2Mm: right,
        y2Mm: round1(32.5 * s),
        thicknessMm: thickness,
      },
      {
        kind: "text",
        id: "cap-sscc",
        xMm: m,
        yMm: round1(33.5 * s),
        text: "SSCC:",
        fontSizePt: captionPt,
        maxWidthMm: contentW,
      },
      {
        kind: "barcode",
        id: "bc-sscc",
        xMm: m,
        yMm: round1(36 * s),
        format: "code128",
        data: "sscc",
        sizeMm: round1(Math.max(3, 3.5 * s)),
      },
    ],
  };
}

/** The five stock box labels seeded to tenants. Pure and deterministic. */
export function buildDefaultLabelTemplates(): DefaultLabelTemplate[] {
  return [
    { name: "Коробка 58×40 (203 dpi)", spec: buildBoxLabelSpec(58, 40, 203) },
    { name: "Коробка 58×40 (300 dpi)", spec: buildBoxLabelSpec(58, 40, 300) },
    { name: "Коробка 75×120 (203 dpi)", spec: buildBoxLabelSpec(75, 120, 203) },
    { name: "Коробка 100×100 (203 dpi)", spec: buildBoxLabelSpec(100, 100, 203) },
    { name: "Коробка 100×150 (203 dpi)", spec: buildBoxLabelSpec(100, 150, 203) },
  ];
}
