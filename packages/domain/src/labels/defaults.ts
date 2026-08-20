import { code128ModuleCount, GS1_128_QUIET_ZONE_MODULES } from "./code128.js";
import type { LabelTemplateSpec } from "./model.js";
import { LINE_HEIGHT_EM, ptToMm } from "./wrap.js";

/** One stock template: seed name (the idempotency key) + its spec. */
export interface DefaultLabelTemplate {
  name: string;
  spec: LabelTemplateSpec;
}

/** The stock template new tenants get as their default box label. */
export const DEFAULT_BOX_LABEL_TEMPLATE_NAME = "Коробка 58×40 (203 dpi)";

const BASE_WIDTH_MM = 58;
const BASE_HEIGHT_MM = 40;

/**
 * How many lines the product name may occupy. It was two; the first physical
 * print came back with «Сидр полусухой газированный "ДИКИЙ КРЕСТ" 0.45 л.»
 * already filling both, and that is not the longest name in the catalogue.
 * The third line is paid for by the removed «SSCC:» caption plus the ЕГАИС
 * block collapsing onto one row — see `buildBoxLabelSpec`'s budget.
 */
const NAME_LINES = 3;

/** Vertical breathing room on either side of a separator rule (58×40 base). */
const BLOCK_GAP_MM = 0.3;
/** Gap between a caption and the value directly beneath it (58×40 base). */
const CAPTION_GAP_MM = 0.15;
/** Gap between the SSCC bars and their human-readable digits (58×40 base). */
const BARCODE_TEXT_GAP_MM = 0.2;

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Millimetre values are kept to 0.1 mm so the inlined migration JSON stays
 * readable — but a barcode's X-DIMENSION cannot be: 0.1 mm is most of a dot,
 * and rounding 0.2502 mm to 0.3 mm would make `mmToDots` emit a 2.4→2 dot
 * module on one printer and a 3-dot one on another. Four decimals is well
 * inside half a dot at 300 dpi, so the round-trip through `mmToDots` is exact.
 */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Directed 0.1 mm rounding, but on the value's DECIMAL tenths rather than its
 * binary ones. A cursor built by adding mm floats lands on 47.99999999999997
 * tenths where the arithmetic means 48, and a naive `Math.floor` would turn a
 * 4.8 mm barcode into 4.7 mm — a tenth of a millimetre of silent drift that
 * changes the seeded JSON. Six decimal places is far finer than any dimension
 * here and far coarser than the error, so it collapses exactly that noise.
 */
function tenths(v: number): number {
  return Number((v * 10).toFixed(6));
}

/** Rounds a y-cursor UP to 0.1 mm, so rounding never eats the gap it just added. */
function ceil1(v: number): number {
  return Math.ceil(tenths(v)) / 10;
}

/** Rounds DOWN to 0.1 mm — for the last block, whose slack is the label edge. */
function floor1(v: number): number {
  return Math.floor(tenths(v)) / 10;
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
 * The vertical space a line of `sizePt` type occupies — the SAME 1.5em line
 * box the rasterizers, `wrap.ts` and `bounds.ts` all assume. The budget below
 * is computed from THIS, per template, rather than from a table of hard-coded
 * y positions: `pt()` rounds the scaled font size to a whole point, so a
 * scaled label's real line box is never exactly `s ×` the base one, and a
 * hard-coded table drifts away from the type it is supposed to be sizing.
 */
function lineHeightMm(sizePt: number): number {
  return ptToMm(sizePt) * LINE_HEIGHT_EM;
}

/**
 * An SSCC is ALWAYS 18 digits, and both emitters prefix the `(00)`
 * application identifier themselves, so the encoded payload is always exactly
 * 20 digits — and a 20-digit GS1-128 in subset C is always exactly 156
 * modules (`code128.ts` has the arithmetic). That determinism is the whole
 * reason `barcodeXMm` below can CENTRE the symbol without a layout engine and
 * without an alignment property in the model.
 */
const SSCC_BARCODE_MODULES = code128ModuleCount("0".repeat(20), true);

/**
 * The widest X-dimension whose symbol AND its two mandatory 10X quiet zones
 * still fit `contentWMm`, expressed as a whole number of printer dots (the
 * only width a printer can actually draw).
 *
 * The quiet zones are inside the budget on purpose. Bars alone would allow a
 * wider module — at 300 dpi a 4-dot module puts 156 modules in 52.8 mm, which
 * "fits" a 58 mm label until you notice it leaves 2.6 mm of margin where
 * GS1 requires 3.4 mm, i.e. a symbol scanners are entitled to reject. Costing
 * `156 + 2 × 10` modules instead picks 3 dots (0.254 mm, 39.6 mm of bars)
 * with 9.2 mm of quiet zone on each side.
 *
 * At 203 dpi this lands on a 2-dot module = 0.2502 mm, which is already
 * GS1's minimum X-dimension: 3 dots would be 58.6 mm of bars on a 58 mm
 * label, so the 203 dpi templates are as wide as the standard permits and
 * only centring and height were ever available to them.
 */
function ssccModuleWidthMm(contentWMm: number, dpi: 203 | 300): number {
  const dotMm = 25.4 / dpi;
  const perDotMm = (SSCC_BARCODE_MODULES + 2 * GS1_128_QUIET_ZONE_MODULES) * dotMm;
  const dots = Math.max(1, Math.floor(contentWMm / perDotMm));
  return round4(dots * dotMm);
}

/**
 * The approved mock-up layout (58×40 base), scaled uniformly to the target
 * size and anchored top-left. Separator lines and the three-column block use
 * the label's ACTUAL width, so wide labels don't leave a dead right margin.
 * Larger sizes keep the same structure with proportionally larger type.
 *
 * VERTICAL BUDGET. It is COMPUTED, not tabulated: a running cursor starts at
 * the top margin and each block advances it by its own 1.5em line box (the
 * one `bounds.ts` and the rasterizers assume) plus a scaled gap. The barcode
 * is what absorbs the remainder — it is placed after the last rule and grown
 * until it meets the digits line, which is itself pinned one bottom margin
 * above the base layout's floor. For the 58×40 base that works out to:
 *
 * | block               | y     | extent |
 * | ------------------- | ----- | ------ |
 * | product name ×3     |  2.0  | 17.88  |
 * | separator 1         | 18.2  | 18.50  |
 * | captions (5pt)      | 18.8  | 21.45  |
 * | values (8pt)        | 21.6  | 25.83  |
 * | separator 2         | 26.2  | 26.50  |
 * | ЕГАИС caption+value | 26.8  | 31.03  |
 * | separator 3         | 31.4  | 31.70  |
 * | SSCC barcode        | 32.0  | 36.80  |
 * | SSCC digits         | 37.0  | 39.65  |
 *
 * THREE NAME LINES cost 5.29 mm over the two the first print shipped with,
 * and only 2.65 mm of that came from dropping the «SSCC:» caption (the
 * digits under the barcode already identify it, and at 5 pt the caption was
 * barely legible on the physical label). The rest — and the barcode's rise
 * from 3.5 mm to 4.8 mm — is paid for by the ЕГАИС block, whose caption now
 * sits in the first column of the SAME row as its value instead of on a line
 * of its own. That is one 8 pt line box (4.23 mm) reclaimed for a block whose
 * caption and value together are only ~39 mm of a 54 mm content width. Four
 * name lines remain impossible: 21 mm of a 40 mm label leaves nothing for a
 * scannable barcode.
 *
 * THE BARCODE IS CENTRED, and `defaults.ts` computes its `xMm` itself rather
 * than the model gaining an alignment property: the SSCC symbol's width is
 * fully determined (see `SSCC_BARCODE_MODULES`), so centring is arithmetic,
 * not layout. `moduleWidthMm` is set explicitly on it for the same reason
 * `model.ts` documents that field — without it the X-dimension is whatever
 * modal `^BY` the previous label left behind.
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
  const cols: [number, number, number] = [m, round1(m + colW), round1(m + 2 * colW)];
  const thickness = round1(Math.max(0.2, 0.3 * s));
  const captionPt = pt(5, s);
  const valuePt = pt(8, s);
  const namePt = pt(10, s);

  const blockGap = BLOCK_GAP_MM * s;
  const captionGap = CAPTION_GAP_MM * s;
  const barcodeTextGap = BARCODE_TEXT_GAP_MM * s;
  // The design's own 40 mm-tall box, scaled. A 75×120 or 100×150 label is far
  // taller than the uniformly-scaled layout needs, and stretching the blocks
  // to fill it would stop the five templates from being the same design; the
  // surplus stays as bottom margin, exactly as it did before.
  const layoutH = BASE_HEIGHT_MM * s;

  const nameY = m;
  const sep1Y = ceil1(nameY + lineHeightMm(namePt) * NAME_LINES + blockGap);
  const capRowY = ceil1(sep1Y + thickness + blockGap);
  const valRowY = ceil1(capRowY + lineHeightMm(captionPt) + captionGap);
  const sep2Y = ceil1(valRowY + lineHeightMm(valuePt) + blockGap);
  const egaisY = ceil1(sep2Y + thickness + blockGap);
  const sep3Y = ceil1(egaisY + lineHeightMm(valuePt) + blockGap);
  const barcodeY = ceil1(sep3Y + thickness + blockGap);
  const digitsY = floor1(layoutH - blockGap - lineHeightMm(captionPt));
  // The floor keeps `parseLabelTemplate`'s "sizeMm must be positive" true for
  // a hypothetical future size whose type does not leave room for bars; at
  // the five stock sizes the remainder is 4.8 mm or more and it never binds.
  const barcodeH = Math.max(0.1, floor1(digitsY - barcodeTextGap - barcodeY));

  const moduleWidthMm = ssccModuleWidthMm(contentW, dpi);
  const barcodeX = round1((widthMm - SSCC_BARCODE_MODULES * moduleWidthMm) / 2);

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
        yMm: nameY,
        field: "product.name",
        fontSizePt: namePt,
        bold: true,
        maxWidthMm: contentW,
        maxLines: NAME_LINES,
      },
      {
        kind: "line",
        id: "sep1",
        xMm: m,
        yMm: sep1Y,
        x2Mm: right,
        y2Mm: sep1Y,
        thicknessMm: thickness,
      },
      {
        kind: "text",
        id: "cap-date",
        xMm: cols[0],
        yMm: capRowY,
        text: "Дата производства:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "text",
        id: "cap-expiry",
        xMm: cols[1],
        yMm: capRowY,
        text: "Годен до:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "text",
        id: "cap-qty",
        xMm: cols[2],
        yMm: capRowY,
        text: "Кол-во в упаковке:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-date",
        xMm: cols[0],
        yMm: valRowY,
        field: "date",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-expiry",
        xMm: cols[1],
        yMm: valRowY,
        field: "expiry",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-qty",
        xMm: cols[2],
        yMm: valRowY,
        field: "qty",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "line",
        id: "sep2",
        xMm: m,
        yMm: sep2Y,
        x2Mm: right,
        y2Mm: sep2Y,
        thicknessMm: thickness,
      },
      {
        // Caption and value share one row (see the budget above): the caption
        // takes the first of the three columns the block overhead already
        // defines, the value everything right of it.
        kind: "text",
        id: "cap-egais",
        xMm: cols[0],
        yMm: egaisY,
        text: "Код ЕГАИС:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-egais",
        xMm: cols[1],
        yMm: egaisY,
        field: "product.egais",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: round1(contentW - colW),
      },
      {
        kind: "line",
        id: "sep3",
        xMm: m,
        yMm: sep3Y,
        x2Mm: right,
        y2Mm: sep3Y,
        thicknessMm: thickness,
      },
      {
        kind: "barcode",
        id: "bc-sscc",
        xMm: barcodeX,
        yMm: barcodeY,
        format: "code128",
        data: "sscc",
        sizeMm: barcodeH,
        moduleWidthMm,
      },
      {
        // The barcode's human-readable digits, as a real element rather than
        // the printer's own interpretation line — see this function's doc
        // comment. Not bold: it is a manual-fallback reading aid, not a
        // headline, and the bare 18 digits are what a warehouse types in.
        kind: "field",
        id: "val-sscc",
        xMm: m,
        yMm: digitsY,
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
