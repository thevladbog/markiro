import { DomainError } from "../errors.js";
import type { DefaultLabelTemplate } from "./defaults.js";
import { assertDuplicateTemplate } from "./duplicate.js";
import type { LabelTemplateSpec } from "./model.js";

/** The stock label for codes ordered from СУЗ and printed in the office (spec 2026-09-18). */
export const KM_LABEL_TEMPLATE_NAME = "Этикетка КМ 58×40";

/**
 * Data Matrix on the left (24 mm, comfortably above the 12-dot floor at
 * 203 dpi), product name and GTIN on the right, and the crypto-free
 * `01…21…` line along the bottom so a person can read which code this is.
 * Resolution-neutral like every stock template since spec 2026-09-10.
 */
export function buildKmLabelTemplates(): DefaultLabelTemplate[] {
  return [
    {
      name: KM_LABEL_TEMPLATE_NAME,
      spec: {
        widthMm: 58,
        heightMm: 40,
        dpi: 203,
        language: "zpl",
        elements: [
          {
            kind: "barcode",
            id: "km",
            xMm: 2,
            yMm: 2,
            format: "datamatrix",
            data: "km.code",
            sizeMm: 24,
          },
          {
            kind: "field",
            id: "name",
            xMm: 28,
            yMm: 3,
            field: "product.printName",
            fontSizePt: 9,
            bold: true,
            maxWidthMm: 28,
            maxLines: 3,
          },
          {
            kind: "text",
            id: "cap-gtin",
            xMm: 28,
            yMm: 19,
            text: "GTIN",
            fontSizePt: 5,
            maxWidthMm: 28,
          },
          {
            kind: "field",
            id: "gtin",
            xMm: 28,
            yMm: 21.5,
            field: "product.gtin",
            fontSizePt: 7,
            maxWidthMm: 28,
          },
          {
            kind: "field",
            id: "serial",
            xMm: 2,
            yMm: 29,
            field: "km.code",
            textFormat: "km_without_crypto",
            fontSizePt: 6,
            maxWidthMm: 54,
            maxLines: 1,
          },
        ],
      },
    },
  ];
}

/** Same geometry rules as a duplicate label, reported under this purpose's own code. */
export function assertKmTemplate(spec: LabelTemplateSpec): void {
  try {
    assertDuplicateTemplate(spec);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError(
        "KM_LABEL_TEMPLATE_INVALID",
        "KM labels require one in-bounds product Data Matrix and no SSCC",
      );
    }
    throw error;
  }
}
