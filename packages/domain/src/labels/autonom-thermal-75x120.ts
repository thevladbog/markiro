import { SSCC_BARCODE_MODULES } from "./defaults.js";
import {
  LOT_NUMBER_LABEL_FIELD,
  mmToDots,
  withPrinterDpi,
  type LabelElement,
  type LabelField,
  type LabelTemplateSpec,
  type PrinterDpi,
} from "./model.js";

const LEFT = 4;
const RIGHT = 71;
const WIDTH = RIGHT - LEFT;
const VALUE_LEFT = 28;
const VALUE_WIDTH = RIGHT - VALUE_LEFT;
const LOT_PRESENT = { field: LOT_NUMBER_LABEL_FIELD, op: "present" } as const;
const EGAIS_PRESENT = { field: "product.egais", op: "present" } as const;

/** Keep a centred 75×120 SSCC centred after the printer rounds its module width to dots. */
export function withAutonomPrinterDpi(spec: LabelTemplateSpec, dpi: PrinterDpi): LabelTemplateSpec {
  const target = withPrinterDpi(spec, dpi);
  if (target === spec || spec.widthMm !== 75 || spec.heightMm !== 120) return target;
  const elements = spec.elements.map((element) => {
    if (
      element.kind !== "barcode" ||
      element.format !== "code128" ||
      element.data !== "sscc" ||
      element.moduleWidthMm === undefined
    )
      return element;
    const centre = element.xMm + (SSCC_BARCODE_MODULES * element.moduleWidthMm) / 2;
    if (Math.abs(centre - spec.widthMm / 2) > 0.01) return element;
    const moduleDots = Math.max(1, mmToDots(element.moduleWidthMm, dpi));
    const xDots = (mmToDots(spec.widthMm, dpi) - SSCC_BARCODE_MODULES * moduleDots) / 2;
    return { ...element, xMm: (xDots * 25.4) / dpi };
  });
  return { ...target, elements };
}

function rule(id: string, yMm: number): LabelElement {
  return { kind: "line", id, xMm: LEFT, x2Mm: RIGHT, yMm, y2Mm: yMm, thicknessMm: 0.25 };
}

function row(id: string, caption: string, field: LabelField, yMm: number): LabelElement[] {
  const when = field === "product.egais" ? { when: EGAIS_PRESENT } : {};
  return [
    {
      kind: "text",
      id: `cap-${id}`,
      text: caption,
      xMm: LEFT,
      yMm,
      fontSizePt: 11,
      maxWidthMm: field === "product.egais" ? 23 : 38,
      lineHeight: 1,
      ...when,
    },
    {
      kind: "field",
      id: `val-${id}`,
      field,
      xMm: VALUE_LEFT,
      yMm,
      maxWidthMm: VALUE_WIDTH,
      fontSizePt: 11,
      align: "right",
      lineHeight: 1,
      ...(field === "qty" || field === "qty.boxes" || field === "product.egais"
        ? { minFontSizePt: 9 }
        : {}),
      ...when,
    },
  ];
}

function heading(
  type: string,
  nameField: "product.name" | "product.printName",
  nameId: string,
): LabelElement[] {
  return [
    {
      kind: "organization_logo",
      id: "organization-logo",
      source: "organization",
      fallback: "markiro",
      xMm: LEFT,
      yMm: 3.5,
      widthMm: 30,
      heightMm: 6.857143,
    },
    {
      kind: "text",
      id: "cap-title",
      text: type,
      xMm: 36,
      yMm: 4,
      maxWidthMm: 35,
      fontSizePt: 11,
      bold: true,
      align: "right",
      lineHeight: 1,
    },
    {
      kind: "field",
      id: nameId,
      field: nameField,
      xMm: LEFT,
      yMm: 14,
      maxWidthMm: WIDTH,
      maxLines: 3,
      fontSizePt: 13,
      bold: true,
      lineHeight: 1,
    },
    rule("sep1", 34),
  ];
}

function lotRow(yMm: number): LabelElement[] {
  return [
    rule("sep-lot", yMm - 1.2),
    {
      kind: "text",
      id: "cap-lot-number",
      text: "Номер партии",
      xMm: LEFT,
      yMm,
      fontSizePt: 10,
      maxWidthMm: 26,
      lineHeight: 1,
      when: LOT_PRESENT,
    },
    {
      kind: "field",
      id: "val-lot-number",
      field: LOT_NUMBER_LABEL_FIELD,
      xMm: VALUE_LEFT,
      yMm,
      maxWidthMm: VALUE_WIDTH,
      maxLines: 2,
      fontFamily: "sans-serif",
      fontSizePt: 10,
      minFontSizePt: 7,
      lineHeight: 1.05,
      align: "right",
    },
  ];
}

export function buildAutonomDuplicate75x120(
  nameField: "product.name" | "product.printName",
  lot: boolean,
): LabelTemplateSpec {
  return {
    widthMm: 75,
    heightMm: 120,
    dpi: 203,
    language: "zpl",
    elements: [
      ...heading("ДУБЛЬ КОДА", nameField, "product"),
      ...row("date", "Дата производства", "date", 36),
      ...row("expiry", "Годен до", "expiry", 42),
      ...row("egais", "Код ЕГАИС", "product.egais", 48),
      ...(lot ? lotRow(59) : []),
      {
        kind: "barcode",
        id: "km",
        xMm: 22.5,
        yMm: 77,
        sizeMm: 30,
        format: "datamatrix",
        data: "km.code",
      },
      {
        kind: "text",
        id: "cap-marking",
        text: "Код маркировки",
        xMm: LEFT,
        yMm: 108.5,
        maxWidthMm: WIDTH,
        fontSizePt: 9,
        align: "center",
        lineHeight: 1,
      },
      {
        kind: "field",
        id: "marking",
        field: "km.code",
        textFormat: "km_without_crypto",
        xMm: LEFT,
        yMm: 112.5,
        maxWidthMm: WIDTH,
        maxLines: 2,
        fontSizePt: 9,
        align: "center",
        lineHeight: 1,
      },
    ],
  };
}

/** The existing SSCC geometry stays within the media and keeps its module width. */
export function buildAutonomAggregation75x120(
  source: LabelTemplateSpec,
  purpose: "box" | "pallet",
  lot: boolean,
): LabelTemplateSpec {
  const symbol = source.elements.find((element) => element.id === "bc-sscc");
  const hri = source.elements.find((element) => element.id === "val-sscc");
  const title = source.elements.find((element) => element.id === "val-name");
  if (symbol?.kind !== "barcode" || hri?.kind !== "field" || title?.kind !== "field")
    throw new Error("Stock 75×120 layout is missing its title or SSCC");
  const dates = source.elements.some((element) => element.id === "val-date");
  const pallet = purpose === "pallet";
  return {
    ...source,
    elements: [
      ...heading(
        pallet ? "ПАЛЕТА" : "КОРОБКА",
        title.field === "product.printName" ? title.field : "product.name",
        title.id,
      ),
      ...(pallet
        ? [
            ...row("boxes", "Коробов", "qty.boxes", 36),
            ...row("units", "Единиц", "qty", 41.5),
            ...row("date", "Дата производства", "date", 47),
            ...row("expiry", "Годен до", "expiry", 52.5),
            ...row("gtin", "GTIN", "product.gtin", 58),
            ...(lot ? row("egais", "Код ЕГАИС", "product.egais", 62.5) : []),
            ...(lot ? lotRow(68.5) : []),
          ]
        : [
            ...row("qty", "Единиц в коробке", "qty", 36),
            ...(dates
              ? [
                  ...row("date", "Дата производства", "date", 42),
                  ...row("expiry", "Годен до", "expiry", 48),
                ]
              : []),
            ...row("egais", "Код ЕГАИС", "product.egais", dates ? 54 : 42),
            ...(lot ? lotRow(dates ? 65 : 55) : []),
          ]),
      symbol,
      { ...hri, fontFamily: "sans-serif", fontSizePt: 10, yMm: 113 },
    ],
  };
}
