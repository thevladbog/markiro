import {
  boxLabelFields,
  palletLabelFields,
  withPrinterDpi,
  type LabelField,
  type LabelTemplateSpec,
  type RasterizeTextFn,
} from "@markiro/domain";

import { rasterizeText } from "../../labels/rasterizer.js";
import type { PrinterDpi, PrinterLanguage } from "../setup/workstation-settings.js";
import type { WorkShift } from "../shifts/shift-copies.js";

/** What a render needs of a printer: its language and its resolution. */
export interface LabelPrinter {
  language: PrinterLanguage;
  dpi: PrinterDpi;
}

/** A label's fields, as the domain gives them for its template. */
export type LabelFields = Record<LabelField, string>;

/**
 * Turns an emitter's output into its exact bytes, one code unit per byte (the
 * cloud station's `latin1ToBytes`): the TSPL emitter carries its `BITMAP`
 * payload as a latin1 string, which `TextEncoder` would corrupt by encoding
 * every byte above 0x7F as two.
 */
export function latin1ToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/**
 * The fields of a box's label (stage 2a spec §5.7.5) from the shift's
 * snapshot — never from today's catalog: the product, the counterparty and
 * the shift as they were frozen when the shift opened — the box (its SSCC,
 * its count and the time it closed, kept with the box) and the operator who
 * closed it. `egaisCode` is none (no alcohol in stage 2a).
 */
export function boxLabelData(
  shift: WorkShift,
  box: { sscc: string; itemCount: number; closedAt: string },
  operatorName: string | null,
): LabelFields {
  const { product, counterpartyName } = shift.snapshot;
  return boxLabelFields({
    sscc: box.sscc,
    itemCount: box.itemCount,
    productName: product.name,
    productPrintName: product.printName,
    gtin14: product.gtin14,
    egaisCode: null,
    shelfLifeDays: product.shelfLifeDays,
    operatorName,
    counterpartyName,
    closedAt: box.closedAt,
    productionDate: shift.copy.productionDate,
    shiftNumber: shift.copy.number,
  });
}

/**
 * The fields of a pallet's label (pilot spec §6.1, the domain's
 * `palletLabelFields`) from the shift's snapshot, like a box's: the pallet's
 * SSCC, its boxes (`qty.boxes`) and their units (`qty`), the time it closed —
 * kept with the pallet, so a reprint stamps the same dates — and the
 * operator who closed it.
 */
export function palletLabelData(
  shift: WorkShift,
  pallet: { sscc: string; boxCount: number; itemCount: number; closedAt: string },
  operatorName: string | null,
): LabelFields {
  const { product, counterpartyName } = shift.snapshot;
  return palletLabelFields({
    sscc: pallet.sscc,
    boxCount: pallet.boxCount,
    itemCount: pallet.itemCount,
    productName: product.name,
    productPrintName: product.printName,
    gtin14: product.gtin14,
    egaisCode: null,
    shelfLifeDays: product.shelfLifeDays,
    operatorName,
    counterpartyName,
    closedAt: pallet.closedAt,
    productionDate: shift.copy.productionDate,
    shiftNumber: shift.copy.number,
  });
}

/**
 * A label's bytes for one printer (the cloud station's `renderLabelBytes`):
 * the template's millimetre geometry at the printer's own resolution
 * (`withPrinterDpi`), in the printer's language, with non-Latin text drawn by
 * the app's rasterizer — the same model the office previews, so the print
 * and the preview do not drift. A text too large for the canvas rejects with
 * `RasterTooLargeError`; any failure rejects, and the caller records the
 * label as `render_failed`.
 */
export async function renderLabel(
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
  rasterize: RasterizeTextFn = rasterizeText,
  // A unit's code printed again (plan СКЛ) is drawn as the shared GS1 raster, as the
  // cloud's duplicate and the office's preview of a product duplicate draw it.
  options: { kmDataMatrix?: "native" | "raster" } = {},
): Promise<Uint8Array> {
  const { generateTspl, generateZpl } = await import("./label-emitters.js");
  const printSpec = withPrinterDpi(spec, printer.dpi);
  const text =
    printer.language === "tspl"
      ? await generateTspl(printSpec, fields, { rasterizeText: rasterize, ...options })
      : await generateZpl(printSpec, fields, { rasterizeText: rasterize, ...options });
  return latin1ToBytes(text);
}
