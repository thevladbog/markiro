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

/**
 * The clamp is headroom for future sizes, not a live constraint: every
 * template below scales UP from the 58×40 base (`scale >= 1`) and the largest
 * base size is 10 pt, so nothing currently reaches either bound. It is kept
 * so a smaller label (or a larger base size) added later cannot emit a
 * `fontSizePt` outside `model.ts`'s 4–72 range and fail `parseLabelTemplate`.
 */
function pt(base: number, scale: number): number {
  return Math.min(72, Math.max(4, Math.round(base * scale)));
}

/**
 * The approved mock-up layout (58×40 base), scaled uniformly to the target
 * size and anchored top-left. Separator lines and the three-column block use
 * the label's ACTUAL width, so wide labels don't leave a dead right margin.
 * Larger sizes keep the same structure with proportionally larger type.
 *
 * VERTICAL BUDGET (58×40 base; every other size is this times `s`). The
 * y positions below are not decorative — each block is sized so its rendered
 * EXTENT clears the next one, using the 1.5em line box the rasterizers and
 * `bounds.ts` both assume (a pt of type occupies `pt/72*25.4*1.5` mm):
 *
 * | block            | y     | extent  |
 * | ---------------- | ----- | ------- |
 * | product name ×2  |  2.0  | 12.58   |
 * | separator 1      | 13.0  |         |
 * | captions (5pt)   | 14.2  | 16.85   |
 * | values (8pt)     | 17.0  | 21.23   |
 * | separator 2      | 21.6  |         |
 * | ЕГАИС caption    | 22.2  | 24.85   |
 * | ЕГАИС value      | 25.0  | 29.23   |
 * | separator 3      | 29.8  |         |
 * | SSCC caption     | 30.4  | 33.05   |
 * | SSCC barcode     | 33.4  | 36.90   |
 * | SSCC digits      | 37.1  | 39.75   |
 *
 * TWO NAME LINES, not four. The paper mock-up wraps the product name across
 * four lines, but four lines of 10 pt type is 21 mm — over half of a 40 mm
 * label, with the three data blocks and the barcode still to place. Two is
 * what the geometry affords (and, since the whole layout scales uniformly,
 * two on every size); a longer name is ellipsized by `wrap.ts` rather than
 * printed off the edge.
 *
 * SSCC DIGITS ARE AN ELEMENT, not the printer's interpretation line. Neither
 * emitter asks the printer for an HRI line any more (see `zpl.ts`/`tspl.ts`
 * on the `^BCN`/`BARCODE` HRI parameter — they used to disagree, so the same
 * template printed digits on a TSC and none on a Zebra). `val-sscc` below
 * prints them identically in both languages, in a position this layout has
 * actually reserved space for.
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
        maxLines: 2,
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
        yMm: round1(14.2 * s),
        text: "Дата производства:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "text",
        id: "cap-expiry",
        xMm: cols[1]!,
        yMm: round1(14.2 * s),
        text: "Годен до:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "text",
        id: "cap-qty",
        xMm: cols[2]!,
        yMm: round1(14.2 * s),
        text: "Кол-во в упаковке:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-date",
        xMm: cols[0]!,
        yMm: round1(17 * s),
        field: "date",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-expiry",
        xMm: cols[1]!,
        yMm: round1(17 * s),
        field: "expiry",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-qty",
        xMm: cols[2]!,
        yMm: round1(17 * s),
        field: "qty",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "line",
        id: "sep2",
        xMm: m,
        yMm: round1(21.6 * s),
        x2Mm: right,
        y2Mm: round1(21.6 * s),
        thicknessMm: thickness,
      },
      {
        kind: "text",
        id: "cap-egais",
        xMm: m,
        yMm: round1(22.2 * s),
        text: "Код ЕГАИС:",
        fontSizePt: captionPt,
        maxWidthMm: contentW,
      },
      {
        kind: "field",
        id: "val-egais",
        xMm: m,
        yMm: round1(25 * s),
        field: "product.egais",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: contentW,
      },
      {
        kind: "line",
        id: "sep3",
        xMm: m,
        yMm: round1(29.8 * s),
        x2Mm: right,
        y2Mm: round1(29.8 * s),
        thicknessMm: thickness,
      },
      {
        kind: "text",
        id: "cap-sscc",
        xMm: m,
        yMm: round1(30.4 * s),
        text: "SSCC:",
        fontSizePt: captionPt,
        maxWidthMm: contentW,
      },
      {
        kind: "barcode",
        id: "bc-sscc",
        xMm: m,
        yMm: round1(33.4 * s),
        format: "code128",
        data: "sscc",
        sizeMm: round1(Math.max(3, 3.5 * s)),
      },
      {
        // The barcode's human-readable digits, as a real element rather than
        // the printer's own interpretation line — see this function's doc
        // comment. Not bold: it is a manual-fallback reading aid, not a
        // headline, and the bare 18 digits are what a warehouse types in.
        kind: "field",
        id: "val-sscc",
        xMm: m,
        yMm: round1(37.1 * s),
        field: "sscc",
        fontSizePt: captionPt,
        maxWidthMm: contentW,
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
