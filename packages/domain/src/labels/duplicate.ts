import { DomainError } from "../errors.js";
import { labelTemplateUsesField } from "./eligibility.js";
import { labelTemplateSpecSchema, mmToDots, type LabelTemplateSpec } from "./model.js";

/** Stock-label typography and rules: readable fields left, full GS1 symbol right. */
export function buildDuplicateLabelTemplate(dpi: 203 | 300 = 203): LabelTemplateSpec {
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
        field: "product.printName",
        fontSizePt: 8,
        bold: true,
        maxWidthMm: 28,
        maxLines: 3,
      },
      { id: "sep-name", kind: "line", xMm: 2, yMm: 15.3, x2Mm: 30, y2Mm: 15.3, thicknessMm: 0.3 },
      {
        id: "cap-date",
        kind: "text",
        xMm: 2,
        yMm: 15.8,
        text: "Дата розлива:",
        fontSizePt: 5,
        maxWidthMm: 14,
      },
      {
        id: "cap-expiry",
        kind: "text",
        xMm: 16.5,
        yMm: 15.8,
        text: "Годен до:",
        fontSizePt: 5,
        maxWidthMm: 13.5,
      },
      {
        id: "date",
        kind: "field",
        xMm: 2,
        yMm: 18.8,
        field: "date",
        fontSizePt: 6,
        bold: true,
        maxWidthMm: 14,
      },
      {
        id: "expiry",
        kind: "field",
        xMm: 16.5,
        yMm: 18.8,
        field: "expiry",
        fontSizePt: 6,
        bold: true,
        maxWidthMm: 13.5,
      },
      { id: "sep-dates", kind: "line", xMm: 2, yMm: 22.5, x2Mm: 30, y2Mm: 22.5, thicknessMm: 0.3 },
      {
        id: "cap-egais",
        kind: "text",
        xMm: 2,
        yMm: 23,
        text: "Код ЕГАИС:",
        fontSizePt: 5,
        maxWidthMm: 28,
      },
      {
        id: "egais",
        kind: "field",
        xMm: 2,
        yMm: 25.9,
        field: "product.egais",
        fontSizePt: 6,
        bold: true,
        maxWidthMm: 28,
      },
      {
        id: "cap-marking",
        kind: "text",
        xMm: 2,
        yMm: 29.5,
        text: "Код маркировки:",
        fontSizePt: 5,
        maxWidthMm: 28,
      },
      {
        id: "marking",
        kind: "field",
        xMm: 2,
        yMm: 32.5,
        field: "km.code",
        textFormat: "km_without_crypto",
        fontSizePt: 5,
        maxWidthMm: 28,
        maxLines: 2,
      },
      { id: "sep-code", kind: "line", xMm: 31, yMm: 2, x2Mm: 31, y2Mm: 38, thicknessMm: 0.3 },
      {
        id: "km",
        kind: "barcode",
        xMm: 32,
        yMm: 8,
        format: "datamatrix",
        data: "km.code",
        sizeMm: 24,
      },
    ],
  };
}

/** Separate stock presets so operators can select the printer's actual resolution. */
export function buildDuplicateLabelTemplates(): { name: string; spec: LabelTemplateSpec }[] {
  return ([203, 300] as const).map((dpi) => ({
    name: `Дубликат Data Matrix 58×40 (${dpi} dpi)`,
    spec: buildDuplicateLabelTemplate(dpi),
  }));
}

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
    mmToDots(code.sizeMm, parsed.data.dpi) < 12
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
