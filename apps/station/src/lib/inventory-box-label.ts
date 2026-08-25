import {
  formatLabelDate,
  type LabelField,
  type LabelTemplateSpec,
  type RasterizeTextFn,
} from "@markiro/domain";

import { addCalendarDays } from "./box-label.js";
import type { PrinterLanguage } from "./hardware-config.js";
import { renderLabelBytes } from "./print-label.js";

export interface InventoryBoxLabelInput {
  sscc: string;
  quantity: number;
  productName: string;
  productPrintName: string | null;
  gtin14: string;
  egaisCode: string | null;
  shelfLifeDays: number | null;
  productionDate: string;
}

const SSCC = /^[0-9]{18}$/;

export function inventoryBoxLabelFields(input: InventoryBoxLabelInput): Record<LabelField, string> {
  if (!SSCC.test(input.sscc)) throw new Error("inventory box SSCC is invalid");
  const expiry =
    input.shelfLifeDays !== null && Number.isInteger(input.shelfLifeDays) && input.shelfLifeDays > 0
      ? addCalendarDays(input.productionDate, input.shelfLifeDays)
      : "";
  return {
    "product.name": input.productName,
    "product.printName": input.productPrintName ?? input.productName,
    "product.gtin": input.gtin14,
    "product.egais": input.egaisCode ?? "",
    "km.code": "",
    sscc: input.sscc,
    "shift.no": "",
    date: formatLabelDate(input.productionDate),
    expiry: formatLabelDate(expiry),
    qty: String(input.quantity),
    operator: "",
    "counterparty.name": "",
  };
}

export function renderInventoryBoxLabel(
  template: LabelTemplateSpec,
  input: InventoryBoxLabelInput,
  language: PrinterLanguage,
  rasterizeText: RasterizeTextFn,
): Promise<Uint8Array> {
  return renderLabelBytes(template, inventoryBoxLabelFields(input), language, rasterizeText);
}
