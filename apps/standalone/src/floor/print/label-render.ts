import {
  boxLabelFields,
  palletLabelFields,
  withPrinterDpi,
  type LabelField,
  type LabelTemplateSpec,
  type MonoBitmap,
  type RasterizeTextFn,
} from "@markiro/domain";

import { rasterizeDriverText, rasterizeText } from "../../labels/rasterizer.js";
import type { PrinterDpi, PrinterLanguage, PrinterMode } from "../setup/workstation-settings.js";
import type { WorkShift } from "../shifts/shift-copies.js";

/** What a render needs of a printer: its language and its resolution. */
export interface LabelPrinter {
  language: PrinterLanguage;
  dpi: PrinterDpi;
  /** `windows_driver` — a `mono-raster-v1` page for the Windows driver (plan ДРВ); absent — the language. */
  mode?: PrinterMode;
  /** «Лист А4» (plan А4): the shift's A4 sheet instead of the label; only with the driver at 300 dpi. */
  paper?: "a4";
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
 * label as `render_failed`. For a printer in driver mode the bytes are a
 * `mono-raster-v1` page (`renderMonoLabel` + `encodeMonoRaster`), with
 * `rasterizeDriverText` unless a rasterizer is given; the same template,
 * fields and resolution as the RAW path.
 *
 * `logo` is what an `organization_logo` box prints (#703): the shift's
 * organization logo or the bundled Markiro logo (`shiftLabelRender`); `null`
 * leaves the box empty, as the domain does, and the label's geometry is the
 * same with or without it. Both paths take it, so a driver page and a RAW
 * label carry the same picture.
 */
export async function renderLabel(
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
  rasterize?: RasterizeTextFn,
  logo: MonoBitmap | null = null,
  // A unit's code printed again (plan СКЛ) is drawn as the shared GS1 raster, as the
  // cloud's duplicate and the office's preview of a product duplicate draw it. A driver
  // page draws every code as dots anyway, so the option concerns only the RAW languages.
  options: { kmDataMatrix?: "native" | "raster" } = {},
): Promise<Uint8Array> {
  const emitters = await import("./label-emitters.js");
  const printSpec = withPrinterDpi(spec, printer.dpi);
  if (printer.mode === "windows_driver") {
    // The template drawn to the dot at the printer's resolution; the driver
    // prints it 1:1 (plan ДРВ). Text only from the bundled face.
    const page = await emitters.renderMonoLabel(
      printSpec,
      fields,
      rasterize ?? rasterizeDriverText,
      { logo },
    );
    return emitters.encodeMonoRaster(page);
  }
  const deps = { rasterizeText: rasterize ?? rasterizeText, logo, ...options };
  const text =
    printer.language === "tspl"
      ? await emitters.generateTspl(printSpec, fields, deps)
      : await emitters.generateZpl(printSpec, fields, deps);
  return latin1ToBytes(text);
}
