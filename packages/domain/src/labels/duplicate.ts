import { DomainError } from "../errors.js";
import { labelTemplateUsesField } from "./eligibility.js";
import { labelTemplateSpecSchema, mmToDots, type LabelTemplateSpec } from "./model.js";

/** Geometry for the opt-in whole-symbol raster path; legacy module-size templates are unchanged. */
export function buildDuplicateLabelTemplate(): LabelTemplateSpec {
  return {
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    elements: [
      {
        id: "km",
        kind: "barcode",
        xMm: 3,
        yMm: 3,
        format: "datamatrix",
        data: "km.code",
        sizeMm: 24,
      },
      {
        id: "caption",
        kind: "text",
        xMm: 30,
        yMm: 4,
        text: "DATA MATRIX",
        fontSizePt: 8,
        bold: true,
        maxWidthMm: 25,
      },
      {
        id: "gtin",
        kind: "field",
        xMm: 30,
        yMm: 10,
        field: "product.gtin",
        fontSizePt: 7,
        maxWidthMm: 25,
      },
      { id: "date", kind: "field", xMm: 30, yMm: 16, field: "date", fontSizePt: 8, maxWidthMm: 25 },
      {
        id: "product",
        kind: "field",
        xMm: 3,
        yMm: 30,
        field: "product.printName",
        fontSizePt: 9,
        maxWidthMm: 52,
        maxLines: 2,
      },
    ],
  };
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
