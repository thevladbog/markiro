import { code128ModuleCount, GS1_128_QUIET_ZONE_MODULES } from "./code128.js";
import type { LabelElement, LabelTemplateSpec } from "./model.js";
import { estimatedTextWidthMm, LINE_HEIGHT_EM, ptToMm } from "./wrap.js";

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

/**
 * ZPL/TSPL render Cyrillic through the shared 1.5em bitmap canvas. Its glyphs
 * sit about 0.25em below the printers' native ASCII text at the same origin.
 * The dated value row mixes those paths (`5 шт.` versus numeric dates), so the
 * bitmap origin needs this compensation to make the visible baselines agree.
 */
const RASTER_NATIVE_BASELINE_OFFSET_EM = 0.25;

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

/** `model.ts`'s `fontSizePt` range — a spec outside it fails `parseLabelTemplate`. */
const MIN_FONT_SIZE_PT = 4;
const MAX_FONT_SIZE_PT = 72;

/**
 * The PROPORTIONAL size: `base` scaled and rounded to a whole point, clamped
 * to the range `model.ts` accepts.
 *
 * The clamp is headroom for future sizes, not a live constraint: every
 * template below scales UP from the 58×40 base (`scale >= 1`) and the largest
 * base size is 10 pt, so nothing currently reaches either bound. It is kept
 * so a smaller label (or a larger base size) added later cannot emit a
 * `fontSizePt` outside `model.ts`'s 4–72 range and fail `parseLabelTemplate`.
 *
 * This is a CEILING, not the answer — see `fitPt`. `Math.round` can only ever
 * round the type UP relative to the layout around it, because every box on
 * the label scales EXACTLY (`colW = contentW / 3`, no rounding to whole
 * anything) while the type lands on an integer point. At 100 mm the scale is
 * 100/58 = 1.7241, so a 5 pt caption wants 8.62 pt and gets 9 — 4.4 % wider
 * than the column it has to fit, which is exactly how «Дата производства:»
 * and «Кол-во в упаковке:» came off the printer ellipsized on both 100 mm
 * templates while the same captions fitted at 58 mm and at 75 mm (where the
 * rounding happened to go the other way, 6.47 → 6).
 */
function pt(base: number, scale: number): number {
  return Math.min(MAX_FONT_SIZE_PT, Math.max(MIN_FONT_SIZE_PT, Math.round(base * scale)));
}

/** A string this template must print, and the box it has to print it in. */
interface FitConstraint {
  readonly text: string;
  readonly boxMm: number;
}

/**
 * The largest WHOLE point size that is (a) no larger than the proportional
 * size for this template and (b) actually fits every one of `constraints`
 * under `estimatedTextWidthMm` — the very predicate `wrap.ts` uses to decide
 * whether a line gets ellipsized, so "fits" here means "will not be clipped
 * there". Never returns below `MIN_FONT_SIZE_PT`.
 *
 * WHY FIT-DRIVEN RATHER THAN PROPORTIONAL. Proportional scaling silently
 * assumes that if a string fits its box at the base size it fits at every
 * size, and `pt`'s rounding breaks that assumption (see above). Deriving the
 * size from the fit instead makes the invariant true by construction for any
 * size and any caption wording anyone adds later, rather than patching the
 * one magic number that happens to be wrong today.
 *
 * The constraints are taken as a GROUP: elements that share a size share it
 * because they sit in one row and must look like one row, so the group takes
 * the smallest size that satisfies all of them rather than each caption
 * shrinking independently into a ransom note.
 *
 * NO HEADROOM FACTOR is applied. `estimatedTextWidthMm` is a character-count
 * estimate, not a measurement, and padding an estimate with a second fudge
 * factor buys no real safety — while it WOULD shrink the 58×40 base, whose
 * approved, physically printed caption already sits at 17.46 mm in an 18 mm
 * column. Whole-point quantisation is the slack: one point is ~11 % of a
 * caption's width at these sizes.
 */
function fitPt(base: number, scale: number, constraints: readonly FitConstraint[]): number {
  let size = pt(base, scale);
  while (
    size > MIN_FONT_SIZE_PT &&
    constraints.some((c) => estimatedTextWidthMm(c.text, size) > c.boxMm)
  ) {
    size -= 1;
  }
  return size;
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
 * The column captions, named so `fitPt` sizes the type against the SAME
 * strings the elements print. Rewording a caption here automatically resizes
 * the row that carries it instead of quietly overflowing it.
 */
const CAPTION_DATE = "Дата производства:";
const CAPTION_EXPIRY = "Годен до:";
const CAPTION_QTY = "Кол-во в упаковке:";
const CAPTION_EGAIS = "Код ЕГАИС:";

/**
 * WIDEST-CASE SPECIMENS for the data-driven values. A caption's text is known
 * at build time; a value's is not, so each is sized against the widest string
 * its field can realistically produce. Where the field has a fixed format the
 * specimen is exact; where it does not (`qty`, ЕГАИС) it is a generous bound,
 * and anything beyond it is still caught at print time by `maxWidthMm` and
 * `wrap.ts` rather than running off the label.
 */
/** Both dates always render as `дд.мм.гггг` — see `labelFieldDisplayValue`. */
const DATE_SPECIMEN = "00.00.0000";
/** `labelFieldDisplayValue` appends «шт.»; five digits is a full pallet's worth. */
const QTY_SPECIMEN = "10000 шт.";
/** A full ЕГАИС alcocode is 19 digits. */
const EGAIS_SPECIMEN = "0".repeat(19);
/** The SSCC digit line is the `(00)` application identifier plus 18 digits. */
const SSCC_HRI_SPECIMEN = `(00)${"0".repeat(18)}`;

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
 * WHICH FAMILY a spec belongs to. There are two, and they differ in exactly
 * one thing: whether «Дата производства» and «Годен до» are printed.
 *
 * Spelled as a two-valued string rather than a boolean so the call sites in
 * `buildDatedBoxLabelTemplates` / `buildDateFreeBoxLabelTemplates` read as
 * what they mean instead of as a bare `true`/`false` at the end of an
 * argument list of numbers.
 */
type DateFields = "with-dates" | "without-dates";

/**
 * The approved mock-up layout (58×40 base), scaled uniformly to the target
 * size and anchored top-left. Separator lines and the three-column block use
 * the label's ACTUAL width, so wide labels don't leave a dead right margin.
 * Larger sizes keep the same structure with proportionally larger type.
 *
 * ONE BUILDER, TWO FAMILIES. `dates` selects between the dated stock labels
 * and the date-free ones. Everything the two families share — the margins,
 * the column arithmetic, the fit-driven type sizing, the rules, the ЕГАИС
 * row, the centred barcode and its digits — is written once here, so the
 * families cannot drift apart; `withDates` appears in exactly three places
 * below (the fit constraints, one line of the y-cursor, and which elements
 * are emitted), and the product name keeps its three lines in both.
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
 * | quantity bitmap     | 20.9  | 25.13  |
 * | native date values  | 21.6  | 25.83  |
 * | separator 2         | 26.2  | 26.50  |
 * | ЕГАИС caption+value | 26.8  | 31.03  |
 * | separator 3         | 31.4  | 31.70  |
 * | SSCC barcode        | 32.0  | 36.80  |
 * | SSCC digits         | 37.0  | 39.65  |
 *
 * ...and for the DATE-FREE 58×40, where the quantity's caption and value
 * share one row exactly as ЕГАИС's do, to:
 *
 * | block               | y     | extent |
 * | ------------------- | ----- | ------ |
 * | product name ×3     |  2.0  | 17.88  |
 * | separator 1         | 18.2  | 18.50  |
 * | Кол-во caption+val  | 18.8  | 23.03  |
 * | separator 2         | 23.4  | 23.70  |
 * | ЕГАИС caption+value | 24.0  | 28.23  |
 * | separator 3         | 28.6  | 28.90  |
 * | SSCC barcode        | 29.2  | 36.80  |
 * | SSCC digits         | 37.0  | 39.65  |
 *
 * THE FREED SPACE GOES TO THE BARS, not to a fourth name line. 4.8 mm of
 * bars is well under GS1's guidance for a logistics label, and the owner
 * chose height over a fourth line of a name that already gets three: the
 * date-free 58×40 prints 7.6 mm of bars.
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
function buildBoxLabelSpec(
  widthMm: number,
  heightMm: number,
  dpi: 203 | 300,
  dates: DateFields,
): LabelTemplateSpec {
  const withDates = dates === "with-dates";
  const s = Math.min(widthMm / BASE_WIDTH_MM, heightMm / BASE_HEIGHT_MM);
  const m = round1(2 * s);
  const right = round1(widthMm - m);
  const contentW = round1(widthMm - 2 * m);
  const colW = round1(contentW / 3);
  const cols: [number, number, number] = [m, round1(m + colW), round1(m + 2 * colW)];
  /**
   * The box a value gets when it shares its row with its own caption: the
   * caption takes the first of the three columns the block overhead already
   * defines, the value everything right of it. The ЕГАИС row has always been
   * built this way; the date-free family's quantity row is built the same way,
   * which is the whole of the difference between the two families' geometry.
   */
  const pairedValueW = round1(contentW - colW);
  const thickness = round1(Math.max(0.2, 0.3 * s));

  // TYPE IS FIT-DRIVEN, not merely scaled — see `fitPt`. Captions are one
  // group (they share a row and must share a size); values are another. The
  // product name is deliberately NOT in either: it is the one string with no
  // bounded content, and it is already width-safe by a different mechanism —
  // `maxLines: 3` plus `wrap.ts`'s word wrap, which breaks it to the column
  // rather than shrinking the label's headline to fit a customer's longest
  // SKU. Sizing it by fit would drive it to 4 pt on the first long name.
  const captionPt = fitPt(5, s, [
    // Present only in the dated family. As it happens this changes no size
    // today — «Дата производства:» and «Кол-во в упаковке:» are both 18
    // characters, and `estimatedTextWidthMm` counts characters, so the
    // remaining caption binds identically — but the constraint list has to
    // describe what the template ACTUALLY prints, or a future reworded
    // caption would be fitted against a string that is not on the label.
    ...(withDates
      ? [
          { text: CAPTION_DATE, boxMm: colW },
          { text: CAPTION_EXPIRY, boxMm: colW },
        ]
      : []),
    { text: CAPTION_QTY, boxMm: colW },
    { text: CAPTION_EGAIS, boxMm: colW },
    // The SSCC digit line rides on the caption size (it did before this
    // change too) and its box is the full content width, so it never binds.
    { text: SSCC_HRI_SPECIMEN, boxMm: contentW },
  ]);
  const valuePt = fitPt(8, s, [
    ...(withDates ? [{ text: DATE_SPECIMEN, boxMm: colW }] : []),
    // The quantity's box is a third of the content width while it shares a
    // three-column row with the dates, and everything right of the caption
    // once it does not.
    { text: QTY_SPECIMEN, boxMm: withDates ? colW : pairedValueW },
    { text: EGAIS_SPECIMEN, boxMm: pairedValueW },
  ]);
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
  // THE ONE VERTICAL DIFFERENCE BETWEEN THE TWO FAMILIES. With dates the
  // quantity block is a caption ROW above a value ROW; without them the
  // quantity's caption and value share one row, so `valRowY` collapses onto
  // `capRowY` and a whole caption line box plus its gap fall out of the
  // budget. Nothing below is rewritten to spend that space: the cursor simply
  // reaches the last rule earlier, and the barcode — which is defined as the
  // remainder between that rule and the digit line — grows by exactly what
  // the caption row gave back (58×40: 4.8 mm of bars becomes 7.6 mm).
  const valRowY = withDates ? ceil1(capRowY + lineHeightMm(captionPt) + captionGap) : capRowY;
  // Only the dated family compares the rasterized quantity against native
  // ASCII on the same row. In the date-free family its caption is rasterized
  // too, so moving the value alone would break that paired row instead.
  const qtyValueY = withDates
    ? round1(valRowY - ptToMm(valuePt) * RASTER_NATIVE_BASELINE_OFFSET_EM)
    : valRowY;
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

  // Where the quantity's caption and value sit. Third column of the
  // three-column row in the dated family; first column (caption) plus
  // everything right of it (value) in the date-free one.
  const qtyCaptionX = withDates ? cols[2] : cols[0];
  const qtyValueX = withDates ? cols[2] : cols[1];
  const qtyValueW = withDates ? colW : pairedValueW;

  const elements: LabelElement[] = [
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
    ...(withDates
      ? ([
          {
            kind: "text",
            id: "cap-date",
            xMm: cols[0],
            yMm: capRowY,
            text: CAPTION_DATE,
            fontSizePt: captionPt,
            maxWidthMm: colW,
          },
          {
            kind: "text",
            id: "cap-expiry",
            xMm: cols[1],
            yMm: capRowY,
            text: CAPTION_EXPIRY,
            fontSizePt: captionPt,
            maxWidthMm: colW,
          },
        ] satisfies LabelElement[])
      : []),
    {
      kind: "text",
      id: "cap-qty",
      xMm: qtyCaptionX,
      yMm: capRowY,
      text: CAPTION_QTY,
      fontSizePt: captionPt,
      maxWidthMm: colW,
    },
    ...(withDates
      ? ([
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
        ] satisfies LabelElement[])
      : []),
    {
      kind: "field",
      id: "val-qty",
      xMm: qtyValueX,
      yMm: qtyValueY,
      field: "qty",
      fontSizePt: valuePt,
      bold: true,
      maxWidthMm: qtyValueW,
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
      text: CAPTION_EGAIS,
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
      maxWidthMm: pairedValueW,
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
      //
      // CENTRED, because the bars above it are. The second physical print
      // came back with the SSCC block reading skewed, and the barcode was
      // not the culprit: `barcodeX` above centres it to within 0.03 mm.
      // This line was the one out of place — a left-flush `field` at the
      // content margin, so its digits started 7.5 mm left of the bars they
      // belong to. `align` centres it inside the SAME full-width content
      // box the barcode is centred in (`m` … `m + contentW`, whose centre
      // IS the label's centre), so the two share a centre line by
      // construction at every one of the five sizes rather than by a
      // hand-tuned x. All three renderers honour it identically — see
      // `rasterAlignOffsetDots`.
      kind: "field",
      id: "val-sscc",
      xMm: m,
      yMm: digitsY,
      field: "sscc",
      fontSizePt: captionPt,
      align: "center",
      maxWidthMm: contentW,
    },
  ];

  return { widthMm, heightMm, dpi, language: "zpl", elements };
}

/** The five stock sizes both families are cut in. */
const BOX_LABEL_SIZES: ReadonlyArray<{ w: number; h: number; dpi: 203 | 300 }> = [
  { w: 58, h: 40, dpi: 203 },
  { w: 58, h: 40, dpi: 300 },
  { w: 75, h: 120, dpi: 203 },
  { w: 100, h: 100, dpi: 203 },
  { w: 100, h: 150, dpi: 203 },
];

/**
 * The five DATED stock box labels — the original family, and the one
 * `DEFAULT_BOX_LABEL_TEMPLATE_NAME` points into. Pure and deterministic.
 */
export function buildDatedBoxLabelTemplates(): DefaultLabelTemplate[] {
  return BOX_LABEL_SIZES.map(({ w, h, dpi }) => ({
    name: `Коробка ${w}×${h} (${dpi} dpi)`,
    spec: buildBoxLabelSpec(w, h, dpi, "with-dates"),
  }));
}

/**
 * The five DATE-FREE stock box labels: same five sizes, same design, minus
 * «Дата производства» and «Годен до». For goods whose packaging already
 * carries the dates (or has none to carry) — and, because the space the two
 * columns used to take goes to the SSCC symbol, with materially taller bars.
 *
 * THE NAMES ARE THE SEED IDENTITY. They are the `(tenant_id, name)`
 * idempotency key of the backfill migration and of tenant provisioning;
 * renaming one here re-seeds it as a second row rather than updating the
 * first.
 */
export function buildDateFreeBoxLabelTemplates(): DefaultLabelTemplate[] {
  return BOX_LABEL_SIZES.map(({ w, h, dpi }) => ({
    name: `Коробка ${w}×${h} без дат (${dpi} dpi)`,
    spec: buildBoxLabelSpec(w, h, dpi, "without-dates"),
  }));
}

/**
 * Every stock box label a tenant is seeded with: the dated five followed by
 * the date-free five. Provisioning inserts exactly this list.
 */
export function buildDefaultLabelTemplates(): DefaultLabelTemplate[] {
  return [...buildDatedBoxLabelTemplates(), ...buildDateFreeBoxLabelTemplates()];
}
