import type { PalletSheetSpecV2 } from "../../src/index.js";

export function makeSheetSpec(): PalletSheetSpecV2 {
  return {
    schemaVersion: 2,
    kind: "pallet_sheet",
    dpi: 300,
    page: {
      size: "A4",
      orientation: "portrait",
      copies: 1,
      cutLine: false,
      marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    },
    body: [
      {
        id: "logo",
        kind: "organization_logo",
        source: "organization",
        fallback: "markiro",
        maxHeightMm: 16,
      },
      {
        id: "name",
        kind: "field",
        field: "product.printName",
        fontSizePt: 22,
        maxLines: 5,
        reservedLines: 5,
      },
      {
        id: "date",
        kind: "field_row",
        label: "ПРОИЗВЕДЕНО",
        field: "productionDate",
        fontSizePt: 14,
        when: { field: "productionDate", op: "present" },
      },
    ],
    footer: {
      id: "sscc",
      kind: "sscc",
      source: "sscc",
      barHeightMm: 45,
      moduleDots: 11,
      align: "center",
    },
  };
}

export const legacySpec = {
  widthMm: 100,
  heightMm: 150,
  dpi: 203 as const,
  language: "zpl" as const,
  elements: [
    { id: "caption", kind: "text" as const, xMm: 3, yMm: 3, text: "ПАЛЕТА", fontSizePt: 12 },
  ],
};
