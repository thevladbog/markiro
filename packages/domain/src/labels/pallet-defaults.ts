import type { DefaultLabelTemplate } from "./defaults.js";
import { SSCC_BARCODE_MODULES, ssccModuleWidthMm } from "./defaults.js";
import type { LabelTemplateSpec } from "./model.js";

/**
 * The stock PALLET label.
 *
 * Deliberately its own module with its own hand-authored layout rather than
 * another family of `buildBoxLabelSpec`: that builder's budget arithmetic is
 * shared by sixteen stock box templates whose exact bytes migration 0123
 * inlines, so adding a row for the box count there would risk silently
 * reflowing all of them. `duplicate.ts` sets the same precedent for the
 * product-duplicate family.
 *
 * A pallet label is read from a metre away on a stack in a corridor, not at
 * arm's length on a bench, so it is authored large (100×150 mm) with a tall
 * symbol and no three-column compression.
 */

/** Seed identity. Renaming this re-seeds a second row rather than updating. */
export const PALLET_LABEL_TEMPLATE_NAME = "Паллета 100×150";

const WIDTH_MM = 100;
const HEIGHT_MM = 150;
/** Authored at 203 dpi; the station reprints at its own printer's resolution. */
const AUTHORING_DPI = 203 as const;

const MARGIN_MM = 5;
const CONTENT_W_MM = WIDTH_MM - 2 * MARGIN_MM;
/** Half the content width, less a gutter, for the two count columns. */
const COL_W_MM = 42;
const COL2_X_MM = MARGIN_MM + 48;

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function buildPalletLabelSpec(): LabelTemplateSpec {
  // Costed with GS1's two mandatory 10X quiet zones inside the budget, so the
  // symbol cannot end up wide enough to leave a margin scanners may reject.
  const moduleWidthMm = ssccModuleWidthMm(CONTENT_W_MM, AUTHORING_DPI);
  // An SSCC payload is always exactly 20 digits and therefore always exactly
  // 156 modules, which is what lets the symbol be centred without a layout
  // engine — the same determinism `defaults.ts` relies on.
  const barcodeXMm = round1((WIDTH_MM - SSCC_BARCODE_MODULES * moduleWidthMm) / 2);

  return {
    widthMm: WIDTH_MM,
    heightMm: HEIGHT_MM,
    dpi: AUTHORING_DPI,
    language: "zpl",
    elements: [
      {
        kind: "text",
        id: "cap-title",
        xMm: MARGIN_MM,
        yMm: 5,
        text: "ПАЛЛЕТА",
        fontSizePt: 12,
        bold: true,
        maxWidthMm: CONTENT_W_MM,
      },
      {
        kind: "field",
        id: "val-name",
        xMm: MARGIN_MM,
        yMm: 13,
        field: "product.name",
        fontSizePt: 14,
        bold: true,
        maxWidthMm: CONTENT_W_MM,
        // Three lines for the same reason the box labels reserve three: a
        // real Russian product name already fills two.
        maxLines: 3,
      },
      {
        kind: "line",
        id: "sep1",
        xMm: MARGIN_MM,
        yMm: 36,
        x2Mm: WIDTH_MM - MARGIN_MM,
        y2Mm: 36,
        thicknessMm: 0.4,
      },
      {
        kind: "text",
        id: "cap-boxes",
        xMm: MARGIN_MM,
        yMm: 39,
        text: "Коробов:",
        fontSizePt: 8,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "field",
        id: "val-boxes",
        xMm: MARGIN_MM,
        yMm: 45,
        // `labelFieldDisplayValue` appends «кор.», so this reads «120 кор.»
        // and cannot be mistaken for the units figure beside it.
        field: "qty.boxes",
        fontSizePt: 14,
        bold: true,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "text",
        id: "cap-units",
        xMm: COL2_X_MM,
        yMm: 39,
        text: "Единиц:",
        fontSizePt: 8,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "field",
        id: "val-units",
        xMm: COL2_X_MM,
        yMm: 45,
        field: "qty",
        fontSizePt: 14,
        bold: true,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "text",
        id: "cap-date",
        xMm: MARGIN_MM,
        yMm: 58,
        text: "Дата производства:",
        fontSizePt: 8,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "field",
        id: "val-date",
        xMm: MARGIN_MM,
        yMm: 64,
        field: "date",
        fontSizePt: 11,
        bold: true,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "text",
        id: "cap-expiry",
        xMm: COL2_X_MM,
        yMm: 58,
        text: "Годен до:",
        fontSizePt: 8,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "field",
        id: "val-expiry",
        xMm: COL2_X_MM,
        yMm: 64,
        field: "expiry",
        fontSizePt: 11,
        bold: true,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "text",
        id: "cap-shift",
        xMm: MARGIN_MM,
        yMm: 75,
        text: "Смена:",
        fontSizePt: 8,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "field",
        id: "val-shift",
        xMm: MARGIN_MM,
        yMm: 81,
        field: "shift.no",
        fontSizePt: 11,
        bold: true,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "text",
        id: "cap-gtin",
        xMm: COL2_X_MM,
        yMm: 75,
        text: "GTIN:",
        fontSizePt: 8,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "field",
        id: "val-gtin",
        xMm: COL2_X_MM,
        yMm: 81,
        field: "product.gtin",
        fontSizePt: 11,
        bold: true,
        maxWidthMm: COL_W_MM,
      },
      {
        kind: "line",
        id: "sep2",
        xMm: MARGIN_MM,
        yMm: 93,
        x2Mm: WIDTH_MM - MARGIN_MM,
        y2Mm: 93,
        thicknessMm: 0.4,
      },
      {
        kind: "barcode",
        id: "bc-sscc",
        xMm: barcodeXMm,
        yMm: 99,
        format: "code128",
        // The emitters add the `(00)` application identifier themselves; the
        // stored and transported value stays the bare 18 digits, because an
        // export to «Честный знак» is rejected otherwise.
        data: "sscc",
        sizeMm: 30,
        moduleWidthMm,
      },
      {
        // The human-readable digits as a real element rather than the
        // printer's own interpretation line: ZPL and TSPL disagree on whether
        // to emit one, so the same template printed digits on a TSC and none
        // on a Zebra. Centred in the same full-width content box the barcode
        // is centred in, so the two share a centre line by construction.
        kind: "field",
        id: "val-sscc",
        xMm: MARGIN_MM,
        yMm: 132,
        field: "sscc",
        fontSizePt: 12,
        align: "center",
        maxWidthMm: CONTENT_W_MM,
      },
    ],
  };
}

/**
 * The stock pallet label a tenant is seeded with. One size for now: unlike
 * box labels, which have to fit whatever carton a line runs, a pallet label
 * goes on a pallet.
 */
export function buildPalletLabelTemplates(): DefaultLabelTemplate[] {
  return [{ name: PALLET_LABEL_TEMPLATE_NAME, spec: buildPalletLabelSpec() }];
}
