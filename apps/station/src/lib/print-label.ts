import {
  generateTspl,
  generateZpl,
  withPrinterDpi,
  type LabelField,
  type LabelTemplateSpec,
  type PrinterDpi,
  type RasterizeTextFn,
} from "@markiro/domain";
import type { PrinterLanguage } from "./hardware-config.js";

/**
 * Converts an emitter's output to exact bytes, one code unit per byte.
 *
 * The TSPL emitter carries its binary `BITMAP` payload as a latin1 string
 * (pinned in plan 04). `TextEncoder` would UTF-8-encode every byte above
 * 0x7F into two bytes and corrupt the bitmap, so the conversion must be a
 * plain `charCodeAt` walk. ZPL is printable ASCII, where both agree.
 */
export function latin1ToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export interface RenderLabelOptions {
  kmDataMatrix?: "native" | "raster";
  /**
   * The attached printer's resolution. `null` (or omitted) means the
   * workstation was configured before the resolution setting existed: the
   * label then prints at the template's authoring dpi, exactly as before.
   */
  dpi?: PrinterDpi | null;
}

/**
 * Renders a label for the printer actually attached to this workstation.
 *
 * The template's own `language` and `dpi` are deliberately overridden: a spec
 * is printer-neutral millimetre geometry and both emitters consume it, so a
 * plant can run mixed printers against one set of templates. The configured
 * printer language decides the command set and the configured printer
 * resolution decides the dot conversion (spec 2026-09-10).
 */
export async function renderLabelBytes(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
  language: PrinterLanguage,
  rasterizeText: RasterizeTextFn,
  options: RenderLabelOptions = {},
): Promise<Uint8Array> {
  const { dpi = null, ...emitterOptions } = options;
  const printSpec = withPrinterDpi(spec, dpi);
  const text =
    language === "tspl"
      ? await generateTspl(printSpec, data, { rasterizeText, ...emitterOptions })
      : await generateZpl(printSpec, data, { rasterizeText, ...emitterOptions });
  return latin1ToBytes(text);
}
