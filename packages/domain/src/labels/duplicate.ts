import { DomainError } from "../errors.js";
import { labelTemplateUsesField } from "./eligibility.js";
import type { LegacyStockLabelTemplate } from "./defaults.js";
import { labelTemplateSpecSchema, mmToDots, type LabelTemplateSpec } from "./model.js";

/** The text column below the rule; the Data Matrix takes what is left of the width. */
const TEXT_WIDTH_MM = 30;
/** Where the full-width rule sits: under the name, above everything else. */
const RULE_Y_MM = 12;
const CODE_SIZE_MM = 52 - TEXT_WIDTH_MM;

/**
 * Stock duplicate label: the product name across the full width, one rule
 * under it, then readable fields left and the GS1 symbol right.
 *
 * The name used to share the top with the Data Matrix, so it was boxed into
 * the same 30 mm column as the dates and read as a caption on a crowded label.
 * Giving it the whole width is what the rule change buys: the rule now spans
 * the label instead of stopping at the text column, and the symbol drops below
 * it rather than being centred against the full height.
 *
 * The symbol keeps its 22 mm — it carries a full KM including the crypto tail,
 * and shrinking it to buy layout is how a duplicate stops scanning.
 */
export function buildDuplicateLabelTemplate(
  dpi: 203 | 300 = 203,
  nameField: "product.name" | "product.printName" = "product.printName",
): LabelTemplateSpec {
  return {
    widthMm: 58,
    heightMm: 40,
    dpi,
    language: "zpl",
    elements: [
      {
        id: "product",
        kind: "field",
        xMm: 2,
        yMm: 2,
        field: nameField,
        fontSizePt: 9,
        bold: true,
        maxWidthMm: 54,
        maxLines: 2,
      },
      {
        id: "sep-name",
        kind: "line",
        xMm: 2,
        yMm: RULE_Y_MM,
        x2Mm: 56,
        y2Mm: RULE_Y_MM,
        thicknessMm: 0.3,
      },
      {
        id: "cap-date",
        kind: "text",
        xMm: 2,
        yMm: 12.6,
        text: "Дата розлива:",
        fontSizePt: 5,
        maxWidthMm: TEXT_WIDTH_MM / 2,
      },
      {
        id: "cap-expiry",
        kind: "text",
        xMm: 2.5 + TEXT_WIDTH_MM / 2,
        yMm: 12.6,
        text: "Годен до:",
        fontSizePt: 5,
        maxWidthMm: TEXT_WIDTH_MM / 2 - 0.5,
      },
      {
        id: "date",
        kind: "field",
        xMm: 2,
        yMm: 15.5,
        field: "date",
        fontSizePt: 6,
        bold: true,
        maxWidthMm: TEXT_WIDTH_MM / 2,
      },
      {
        id: "expiry",
        kind: "field",
        xMm: 2.5 + TEXT_WIDTH_MM / 2,
        yMm: 15.5,
        field: "expiry",
        fontSizePt: 6,
        bold: true,
        maxWidthMm: TEXT_WIDTH_MM / 2 - 0.5,
      },
      {
        id: "sep-dates",
        kind: "line",
        xMm: 2,
        yMm: 19.2,
        x2Mm: 2 + TEXT_WIDTH_MM,
        y2Mm: 19.2,
        thicknessMm: 0.3,
      },
      {
        id: "cap-egais",
        kind: "text",
        xMm: 2,
        yMm: 19.7,
        text: "Код ЕГАИС:",
        fontSizePt: 5,
        maxWidthMm: TEXT_WIDTH_MM,
      },
      {
        id: "egais",
        kind: "field",
        xMm: 2,
        yMm: 22.6,
        field: "product.egais",
        fontSizePt: 6,
        bold: true,
        maxWidthMm: TEXT_WIDTH_MM,
      },
      {
        id: "cap-marking",
        kind: "text",
        xMm: 2,
        yMm: 26.2,
        text: "Код маркировки:",
        fontSizePt: 5,
        maxWidthMm: TEXT_WIDTH_MM,
      },
      {
        id: "marking",
        kind: "field",
        xMm: 2,
        yMm: 29.1,
        field: "km.code",
        textFormat: "km_without_crypto",
        fontSizePt: 5,
        maxWidthMm: TEXT_WIDTH_MM,
        maxLines: 2,
      },
      {
        id: "sep-code",
        kind: "line",
        xMm: 3 + TEXT_WIDTH_MM,
        yMm: RULE_Y_MM + 0.3,
        x2Mm: 3 + TEXT_WIDTH_MM,
        y2Mm: 38,
        thicknessMm: 0.3,
      },
      {
        id: "km",
        kind: "barcode",
        xMm: 4 + TEXT_WIDTH_MM,
        yMm: RULE_Y_MM + 0.3 + (38 - RULE_Y_MM - 0.3 - CODE_SIZE_MM) / 2,
        format: "datamatrix",
        data: "km.code",
        sizeMm: CODE_SIZE_MM,
      },
    ],
  };
}

/**
 * The layout shipped before the full-width name, kept verbatim.
 *
 * Two migrations read it and neither may drift: 0123 pins the 28 mm form it
 * seeded, and the migration that introduces the layout above matches the 30 mm
 * form byte for byte so it only rewrites rows a tenant never edited.
 */
export function buildPreviousDuplicateLabelLayout(
  dpi: 203 | 300,
  nameField: "product.name" | "product.printName",
  textWidthMm: 28 | 30,
): LabelTemplateSpec {
  return buildDuplicateLabelLayout(dpi, nameField, textWidthMm);
}

function buildDuplicateLabelLayout(
  dpi: 203 | 300,
  nameField: "product.name" | "product.printName",
  textWidthMm: 28 | 30,
): LabelTemplateSpec {
  const codeSizeMm = 52 - textWidthMm;
  return {
    widthMm: 58,
    heightMm: 40,
    dpi,
    language: "zpl",
    elements: [
      {
        id: "product",
        kind: "field",
        xMm: 2,
        yMm: 2,
        field: nameField,
        fontSizePt: 8,
        bold: true,
        maxWidthMm: textWidthMm,
        maxLines: 3,
      },
      {
        id: "sep-name",
        kind: "line",
        xMm: 2,
        yMm: 15.3,
        x2Mm: 2 + textWidthMm,
        y2Mm: 15.3,
        thicknessMm: 0.3,
      },
      {
        id: "cap-date",
        kind: "text",
        xMm: 2,
        yMm: 15.8,
        text: "Дата розлива:",
        fontSizePt: 5,
        maxWidthMm: textWidthMm / 2,
      },
      {
        id: "cap-expiry",
        kind: "text",
        xMm: 2.5 + textWidthMm / 2,
        yMm: 15.8,
        text: "Годен до:",
        fontSizePt: 5,
        maxWidthMm: textWidthMm / 2 - 0.5,
      },
      {
        id: "date",
        kind: "field",
        xMm: 2,
        yMm: 18.8,
        field: "date",
        fontSizePt: 6,
        bold: true,
        maxWidthMm: textWidthMm / 2,
      },
      {
        id: "expiry",
        kind: "field",
        xMm: 2.5 + textWidthMm / 2,
        yMm: 18.8,
        field: "expiry",
        fontSizePt: 6,
        bold: true,
        maxWidthMm: textWidthMm / 2 - 0.5,
      },
      {
        id: "sep-dates",
        kind: "line",
        xMm: 2,
        yMm: 22.5,
        x2Mm: 2 + textWidthMm,
        y2Mm: 22.5,
        thicknessMm: 0.3,
      },
      {
        id: "cap-egais",
        kind: "text",
        xMm: 2,
        yMm: 23,
        text: "Код ЕГАИС:",
        fontSizePt: 5,
        maxWidthMm: textWidthMm,
      },
      {
        id: "egais",
        kind: "field",
        xMm: 2,
        yMm: 25.9,
        field: "product.egais",
        fontSizePt: 6,
        bold: true,
        maxWidthMm: textWidthMm,
      },
      {
        id: "cap-marking",
        kind: "text",
        xMm: 2,
        yMm: 29.5,
        text: "Код маркировки:",
        fontSizePt: 5,
        maxWidthMm: textWidthMm,
      },
      {
        id: "marking",
        kind: "field",
        xMm: 2,
        yMm: 32.5,
        field: "km.code",
        textFormat: "km_without_crypto",
        fontSizePt: 5,
        maxWidthMm: textWidthMm,
        maxLines: 2,
      },
      {
        id: "sep-code",
        kind: "line",
        xMm: 3 + textWidthMm,
        yMm: 2,
        x2Mm: 3 + textWidthMm,
        y2Mm: 38,
        thicknessMm: 0.3,
      },
      {
        id: "km",
        kind: "barcode",
        xMm: 4 + textWidthMm,
        yMm: (40 - codeSizeMm) / 2,
        format: "datamatrix",
        data: "km.code",
        sizeMm: codeSizeMm,
      },
    ],
  };
}

/** Family name and the legacy seed identity retained by migration 0123. */
export const DUPLICATE_LABEL_TEMPLATE_NAME = "Дубликат Data Matrix 58×40";

/**
 * Full-name and short-name presets, authored at 203 dpi. The station renders
 * either at its printer's resolution (`withPrinterDpi`).
 */
export function buildDuplicateLabelTemplates(): { name: string; spec: LabelTemplateSpec }[] {
  return [
    {
      name: `${DUPLICATE_LABEL_TEMPLATE_NAME} [Полное наименование]`,
      spec: buildDuplicateLabelTemplate(203, "product.name"),
    },
    {
      name: `${DUPLICATE_LABEL_TEMPLATE_NAME} [Краткое наименование]`,
      spec: buildDuplicateLabelTemplate(203),
    },
  ];
}

/**
 * The two presets exactly as 0125 left them, for the migration that replaces
 * their layout: it rewrites only rows matching these bytes, so a tenant that
 * edited its copy keeps it. Provisioning does not use this.
 */
export function buildPreviousDuplicateLabelTemplates(): {
  name: string;
  spec: LabelTemplateSpec;
}[] {
  return [
    {
      name: `${DUPLICATE_LABEL_TEMPLATE_NAME} [Полное наименование]`,
      spec: buildPreviousDuplicateLabelLayout(203, "product.name", 30),
    },
    {
      name: `${DUPLICATE_LABEL_TEMPLATE_NAME} [Краткое наименование]`,
      spec: buildPreviousDuplicateLabelLayout(203, "product.printName", 30),
    },
  ];
}

/**
 * The pre-2026-09-10 presets, one per resolution, as migrations 0114/0115
 * seeded them: for migration 0123 (rename the 203 row, disable the untouched
 * 300 twin) and its drift guard. Provisioning does not use this.
 */
export function buildLegacyDuplicateLabelTemplates(): LegacyStockLabelTemplate[] {
  return ([203, 300] as const).map((dpi) => ({
    name: `Дубликат Data Matrix 58×40 (${dpi} dpi)`,
    spec: buildDuplicateLabelLayout(dpi, "product.printName", 28),
    renamedTo: dpi === 203 ? DUPLICATE_LABEL_TEMPLATE_NAME : null,
  }));
}

/**
 * A template may print on any supported printer (spec 2026-09-10), so the
 * "at least 12 dots per code" floor is judged at the COARSEST resolution:
 * a code that is big enough at 203 dpi is big enough at 300.
 */
const COARSEST_PRINTER_DPI = 203;

export function assertDuplicateTemplate(spec: LabelTemplateSpec): void {
  const parsed = labelTemplateSpecSchema.safeParse(spec);
  if (!parsed.success) invalidTemplate();
  const codeElements = parsed.data.elements.filter(
    (element) => element.kind === "barcode" && element.data === "km.code",
  );
  const code = codeElements[0];
  if (
    codeElements.length !== 1 ||
    !code ||
    code.kind !== "barcode" ||
    code.format !== "datamatrix" ||
    labelTemplateUsesField(parsed.data, "sscc") ||
    code.xMm < 0 ||
    code.yMm < 0 ||
    code.xMm + code.sizeMm > parsed.data.widthMm ||
    code.yMm + code.sizeMm > parsed.data.heightMm ||
    mmToDots(code.sizeMm, COARSEST_PRINTER_DPI) < 12
  )
    invalidTemplate();
  // The raster reserves its quiet zone inside this square. Actual payload fit is checked on render.
}

function invalidTemplate(): never {
  throw new DomainError(
    "DUPLICATE_LABEL_TEMPLATE_INVALID",
    "Duplicate labels require one in-bounds product Data Matrix and no SSCC",
  );
}
