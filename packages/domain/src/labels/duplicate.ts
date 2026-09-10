import { DomainError } from "../errors.js";
import { labelTemplateUsesField } from "./eligibility.js";
import type { LegacyStockLabelTemplate } from "./defaults.js";
import { labelTemplateSpecSchema, mmToDots, type LabelTemplateSpec } from "./model.js";

/** Stock-label typography and rules: readable fields left, full GS1 symbol right. */
export function buildDuplicateLabelTemplate(
  dpi: 203 | 300 = 203,
  nameField: "product.name" | "product.printName" = "product.printName",
): LabelTemplateSpec {
  return buildDuplicateLabelLayout(dpi, nameField, 30);
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
