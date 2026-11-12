import type { LabelTemplatePurpose } from "../product-labels/contracts.js";
import {
  buildAutonomAggregation75x120,
  buildAutonomDuplicate75x120,
} from "./autonom-thermal-75x120.js";
import { buildDefaultLabelTemplates } from "./defaults.js";
import { buildDuplicateLabelTemplates } from "./duplicate.js";
import { LOT_NUMBER_LABEL_FIELD, type LabelElement, type LabelTemplateSpec } from "./model.js";
import { buildPalletLabelTemplates } from "./pallet-defaults.js";

export interface StockLotNumberLabelVariant {
  purpose: LabelTemplatePurpose;
  sourceName: string;
  sourceSpec: LabelTemplateSpec;
  updatedSourceSpec?: LabelTemplateSpec;
  previousSpec?: LabelTemplateSpec;
  addSource?: true;
  name: string;
  spec: LabelTemplateSpec;
}

const egaisPresent = { field: "product.egais", op: "present" } as const;
const present = { field: LOT_NUMBER_LABEL_FIELD, op: "present" } as const;

function lotBlock(widthMm: number, bottomMm: number): LabelElement[] {
  const compact = widthMm === 58;
  const xMm = compact ? 2 : 4;
  const maxWidthMm = widthMm - 2 * xMm;
  return [
    {
      kind: "text",
      id: "cap-lot-number",
      text: "Номер партии",
      xMm,
      yMm: bottomMm - (compact ? 7.4 : 11.3),
      maxWidthMm,
      fontSizePt: compact ? 5.5 : 7,
      lineHeight: 1,
      when: present,
    },
    {
      kind: "field",
      id: "val-lot-number",
      field: LOT_NUMBER_LABEL_FIELD,
      xMm,
      yMm: bottomMm - (compact ? 5.2 : 8.4),
      maxWidthMm,
      maxLines: 2,
      fontFamily: "monospace",
      fontSizePt: compact ? 6 : 10,
      minFontSizePt: compact ? 5.5 : 8,
      lineHeight: 1.15,
    },
  ];
}

/** Reserve two lot lines above the SSCC. Keep the symbol and its HRI at their original size and position. */
function aggregationVariant(
  source: LabelTemplateSpec,
  purpose: "box" | "pallet",
): LabelTemplateSpec {
  const rule = source.elements.find((element) => element.id === "sep1");
  const barcode = source.elements.find((element) => element.id === "bc-sscc");
  if (!rule || !barcode) throw new Error("Stock aggregation layout is missing its rule or SSCC");
  const compact = source.widthMm === 58;
  const narrowPallet = source.widthMm === 75 && purpose === "pallet";
  const shiftMm = compact
    ? 7.8
    : narrowPallet
      ? 12.2
      : source.heightMm === 150
        ? 12
        : source.heightMm === 100
          ? 10
          : 9;
  const elements = source.elements.map((element): LabelElement => {
    if (element.kind === "field" && ["val-name", "name"].includes(element.id)) {
      return {
        ...element,
        maxLines: 2,
        ...(compact ? { fontSizePt: 8.5, lineHeight: 1.3 } : {}),
        ...(narrowPallet ? { fontSizePt: 11.8 } : {}),
      };
    }
    if (element.yMm < rule.yMm || element.yMm >= barcode.yMm) return element;
    const yMm = Math.round((element.yMm - shiftMm) * 100) / 100;
    if (element.kind === "line") return { ...element, yMm, y2Mm: yMm };
    if (element.kind === "text" && element.id === "cap-egais")
      return { ...element, yMm, when: egaisPresent };
    if (element.kind === "field" && element.field === "product.egais")
      return { ...element, yMm, when: egaisPresent };
    return { ...element, yMm };
  });
  if (purpose === "pallet" && !compact) {
    // Full-size stock pallets have a GTIN row but no EGAIS row. The two facts
    // can both be present on this variant and neither controls the lot block.
    const yMm = barcode.yMm - 14.8;
    const width = source.widthMm;
    elements.push(
      {
        kind: "text",
        id: "cap-egais",
        text: "ЕГАИС",
        when: egaisPresent,
        xMm: 4,
        yMm,
        maxWidthMm: 21,
        fontSizePt: 9,
        lineHeight: 1,
      },
      {
        kind: "field",
        id: "val-egais",
        field: "product.egais",
        when: egaisPresent,
        xMm: 25,
        yMm,
        maxWidthMm: width - 29,
        fontFamily: "monospace",
        fontSizePt: 9,
        lineHeight: 1,
        align: "right",
      },
    );
  }
  return { ...source, elements: [...elements, ...lotBlock(source.widthMm, barcode.yMm)] };
}

/** Keep the original Data Matrix module area and place the lot under both columns. */
function duplicateVariant(source: LabelTemplateSpec): LabelTemplateSpec {
  const elements = source.elements.map((element): LabelElement => {
    if (element.id === "product" && element.kind === "field")
      return { ...element, lineHeight: 1.1 };
    const yMm = Math.round((element.yMm - (element.id === "km" ? 3.8 : 2.8)) * 100) / 100;
    if (element.kind === "line")
      return { ...element, yMm, y2Mm: element.id === "sep-code" ? 32.6 : yMm };
    if (element.kind === "text" && element.id === "cap-egais")
      return { ...element, yMm, when: egaisPresent };
    if (element.kind === "field" && element.field === "product.egais")
      return { ...element, yMm, when: egaisPresent };
    return { ...element, yMm };
  });
  return { ...source, elements: [...elements, ...lotBlock(source.widthMm, 40)] };
}

/** Separate variants let existing jobs and edited stock layouts retain their saved geometry. */
export function buildStockLotNumberLabelVariants(): StockLotNumberLabelVariant[] {
  const sources = [
    ["box", buildDefaultLabelTemplates()],
    ["pallet", buildPalletLabelTemplates()],
    ["product_duplicate", buildDuplicateLabelTemplates()],
  ] as const;
  const variants: StockLotNumberLabelVariant[] = sources.flatMap(([purpose, templates]) =>
    templates.map(({ name, spec }) => {
      const base = { purpose, sourceName: name, sourceSpec: spec, name: `${name} · номер партии` };
      if (purpose === "product_duplicate") return { ...base, spec: duplicateVariant(spec) };
      const previous = aggregationVariant(spec, purpose);
      if (spec.widthMm !== 75 || spec.heightMm !== 120) return { ...base, spec: previous };
      return {
        ...base,
        updatedSourceSpec: buildAutonomAggregation75x120(spec, purpose, false),
        previousSpec: previous,
        spec: buildAutonomAggregation75x120(spec, purpose, true),
      };
    }),
  );
  for (const [nameField, variant] of [
    ["product.name", "Полное наименование"],
    ["product.printName", "Краткое наименование"],
  ] as const) {
    const name = `Дубликат Data Matrix 75×120 [${variant}]`;
    variants.push({
      purpose: "product_duplicate",
      sourceName: name,
      sourceSpec: buildAutonomDuplicate75x120(nameField, false),
      name: `${name} · номер партии`,
      spec: buildAutonomDuplicate75x120(nameField, true),
      addSource: true,
    });
  }
  return variants;
}

export function buildAutonomStockLabelTemplates() {
  return buildStockLotNumberLabelVariants().map(
    ({ purpose, sourceName, sourceSpec, updatedSourceSpec }) => ({
      purpose,
      name: sourceName,
      spec: updatedSourceSpec ?? sourceSpec,
    }),
  );
}
