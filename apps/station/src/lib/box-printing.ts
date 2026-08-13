import type { LabelTemplateSpec } from "@markiro/domain";
import type { BoxPrintErrorCode } from "./boxes.js";
import type { PrintTarget } from "./hardware.js";
import type { PrinterLanguage } from "./hardware-config.js";

export type BoxPrintAttempt =
  { kind: "printed"; bytes: Uint8Array } | { kind: "failed"; code: BoxPrintErrorCode };

export interface BoxPrintInput {
  template: LabelTemplateSpec | null;
  fields: Record<string, string>;
  printing: {
    target: PrintTarget;
    language: PrinterLanguage;
    print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  } | null;
  render: (
    template: LabelTemplateSpec,
    fields: Record<string, string>,
    language: PrinterLanguage,
  ) => Promise<Uint8Array>;
}

export async function attemptBoxPrint(input: BoxPrintInput): Promise<BoxPrintAttempt> {
  if (!input.template) return { kind: "failed", code: "template_missing" };
  if (!input.printing) return { kind: "failed", code: "printer_unconfigured" };

  let bytes: Uint8Array;
  try {
    bytes = await input.render(input.template, input.fields, input.printing.language);
  } catch {
    console.error("station: box label render failed");
    return { kind: "failed", code: "render_failed" };
  }

  try {
    await input.printing.print(input.printing.target, bytes);
  } catch {
    console.error("station: box label transport failed");
    return { kind: "failed", code: "transport_failed" };
  }

  return { kind: "printed", bytes };
}
