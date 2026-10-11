import {
  parsePalletSheetSpec,
  type PalletSheetSpecV2,
  type SheetNode,
  type PalletSheetField,
} from "./pallet-sheet-model.js";
export interface PalletSheetPreset {
  key: string;
  name: string;
  purpose: "pallet";
  spec: PalletSheetSpecV2;
}
function fieldRow(
  id: string,
  label: string,
  field: PalletSheetField,
  size: number,
  conditional = false,
): SheetNode {
  return {
    id,
    kind: "field_row",
    label,
    field,
    fontSizePt: size,
    labelFontSizePt: 7,
    gapMm: 0.6,
    ...(conditional ? { when: { field, op: "present" as const } } : {}),
  };
}
function row(id: string, children: SheetNode[], gapMm = 4): SheetNode {
  return { id, kind: "row", gapMm, children };
}
function stack(id: string, children: SheetNode[], gapMm = 1): SheetNode {
  return { id, kind: "stack", gapMm, children };
}
function make(orientation: "portrait" | "landscape", copies: 1 | 2): PalletSheetSpecV2 {
  const small = copies === 2;
  const header = row(
    "header",
    [
      {
        id: "logo",
        kind: "organization_logo",
        source: "organization",
        fallback: "markiro",
        maxHeightMm: small ? 12 : 16,
      },
      stack("organization", [
        {
          id: "org-name",
          kind: "field",
          field: "organization.name",
          fontSizePt: small ? 11 : 16,
          maxLines: 2,
          bold: true,
        },
        { id: "label-title", kind: "text", text: "ПАЛЕТА", fontSizePt: 8 },
      ]),
    ],
    2,
  );
  const product: SheetNode = {
    id: "product",
    kind: "field",
    field: "product.printName",
    fontSizePt: small ? 16 : 22,
    bold: true,
    maxLines: orientation === "landscape" && !small ? 4 : 5,
    reservedLines: orientation === "landscape" && !small ? 4 : 5,
  };
  const quantities = row("quantities", [
    fieldRow("boxes", "КОРОБОВ", "boxCount", small ? 28 : 36),
    fieldRow("units", "ЕДИНИЦ", "itemCount", small ? 28 : 36),
  ]);
  const dates = row("dates", [
    fieldRow("production", "ПРОИЗВЕДЕНО", "productionDate", small ? 10 : 14, true),
    fieldRow("expiry", "ГОДЕН ДО", "expiryDate", small ? 10 : 14, true),
  ]);
  const identifiers = row("identifiers", [
    fieldRow("gtin", "GTIN", "product.gtin", small ? 10 : 12),
    fieldRow("shift", "СМЕНА", "shiftNumber", small ? 10 : 12, true),
  ]);
  const egais = fieldRow("egais", "КОД ЕГАИС", "product.egais", small ? 10 : 12, true);
  const separator: SheetNode = { id: "separator", kind: "line", thicknessMm: 0.3 };
  const body =
    orientation === "landscape" && !small
      ? [
          header,
          separator,
          row(
            "main",
            [
              stack("product-column", [product, identifiers, egais], 4),
              stack("quantity-column", [quantities, dates], 4),
            ],
            12,
          ),
        ]
      : [header, separator, product, quantities, dates, identifiers, egais];
  return parsePalletSheetSpec({
    schemaVersion: 2,
    kind: "pallet_sheet",
    dpi: 300,
    page: {
      size: "A4",
      orientation,
      copies,
      cutLine: small,
      marginsMm: { top: 10, bottom: 10, left: small ? 7 : 10, right: small ? 7 : 10 },
    },
    body: [stack("content", body, small ? 1 : 3)],
    footer: {
      id: "sscc",
      kind: "sscc",
      source: "sscc",
      barHeightMm: 45,
      moduleDots: small ? 9 : 11,
      ...(small ? { fallbackModuleDots: 8 } : {}),
      align: "center",
    },
  });
}
export function buildPalletSheetPresets(): PalletSheetPreset[] {
  return [
    {
      key: "pallet-a4-portrait",
      name: "Палета А4 · вертикальная",
      purpose: "pallet",
      spec: make("portrait", 1),
    },
    {
      key: "pallet-a4-landscape",
      name: "Палета А4 · горизонтальная",
      purpose: "pallet",
      spec: make("landscape", 1),
    },
    {
      key: "pallet-a4-two-a5",
      name: "Палета А4 · две одинаковые А5",
      purpose: "pallet",
      spec: make("landscape", 2),
    },
  ];
}
