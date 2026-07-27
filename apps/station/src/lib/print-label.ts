import {
  generateTspl,
  generateZpl,
  type LabelField,
  type LabelTemplateSpec,
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

/**
 * Renders a label for the printer actually attached to this workstation.
 *
 * The template's own `language` field is deliberately ignored: a spec is
 * language-neutral geometry and both emitters consume it, so a plant can run
 * mixed printers against one set of templates. The configured printer
 * language decides the output.
 */
export async function renderLabelBytes(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
  language: PrinterLanguage,
  rasterizeText: RasterizeTextFn,
): Promise<Uint8Array> {
  const text =
    language === "tspl"
      ? await generateTspl(spec, data, { rasterizeText })
      : await generateZpl(spec, data, { rasterizeText });
  return latin1ToBytes(text);
}
