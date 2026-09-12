import {
  formatLabelDate,
  shelfLifeExpiryDate,
  isValidSscc,
  type LabelField,
  type LabelTemplateSpec,
  type PrinterDpi,
  type RasterizeTextFn,
} from "@markiro/domain";

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

export function inventoryBoxLabelFields(input: InventoryBoxLabelInput): Record<LabelField, string> {
  if (!isValidSscc(input.sscc)) throw new Error("inventory box SSCC is invalid");
  const expiry = shelfLifeExpiryDate(input.productionDate, input.shelfLifeDays);
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
    // A box holds units, not boxes. Empty rather than "0": a zero would print
    // as «0 кор.» on any template that binds the field.
    "qty.boxes": "",
    operator: "",
    "counterparty.name": "",
  };
}

export function renderInventoryBoxLabel(
  template: LabelTemplateSpec,
  input: InventoryBoxLabelInput,
  language: PrinterLanguage,
  rasterizeText: RasterizeTextFn,
  dpi: PrinterDpi | null = null,
): Promise<Uint8Array> {
  return renderLabelBytes(template, inventoryBoxLabelFields(input), language, rasterizeText, {
    dpi,
  });
}
