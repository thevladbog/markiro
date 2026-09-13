import type { LabelTemplateSpec, PrinterDpi } from "@markiro/domain";
import type { BoxPrintErrorCode } from "./boxes.js";
import type { PrintTarget } from "./hardware.js";
import type { PrinterLanguage } from "./hardware-config.js";
import type { SqlExecutor } from "./mirror.js";
import { bindPrintDestination, type PrintDestinationKey } from "./print-destinations.js";
import {
  outputPrinterProfile,
  serializePrinterOutput,
  type PrinterProfile,
} from "./printer-routing.js";

export type BoxPrintAttempt =
  { kind: "printed"; bytes: Uint8Array } | { kind: "failed"; code: BoxPrintErrorCode };

export interface BoxPrintInput {
  template: LabelTemplateSpec | null;
  fields: Record<string, string>;
  destination?: {
    exec: SqlExecutor;
    key: PrintDestinationKey;
    print?: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  };
  printing: {
    profile?: PrinterProfile;
    target: PrintTarget;
    language: PrinterLanguage;
    /**
     * The attached printer's resolution. Omitted or null = the workstation
     * was configured before the setting existed: the label prints at its
     * authoring dpi, exactly as before (spec 2026-09-10).
     */
    dpi?: PrinterDpi | null;
    print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  } | null;
  render: (
    template: LabelTemplateSpec,
    fields: Record<string, string>,
    language: PrinterLanguage,
    dpi: PrinterDpi | null,
  ) => Promise<Uint8Array>;
}

export async function attemptBoxPrint(input: BoxPrintInput): Promise<BoxPrintAttempt> {
  if (!input.template) return { kind: "failed", code: "template_missing" };
  const candidate = input.printing ? outputPrinterProfile(input.printing) : null;
  let printer: PrinterProfile | null;
  try {
    printer = input.destination
      ? await bindPrintDestination(input.destination.exec, input.destination.key, candidate)
      : candidate;
  } catch {
    console.error("station: print destination could not be saved");
    return { kind: "failed", code: "persistence_failed" };
  }
  const print = input.destination?.print ?? input.printing?.print;
  if (!printer || !print) return { kind: "failed", code: "printer_unconfigured" };

  let bytes: Uint8Array;
  try {
    bytes = await input.render(input.template, input.fields, printer.language, printer.dpi);
  } catch {
    console.error("station: box label render failed");
    return { kind: "failed", code: "render_failed" };
  }

  try {
    await serializePrinterOutput(printer.target, () => print(printer.target, bytes));
  } catch {
    console.error("station: box label transport failed");
    return { kind: "failed", code: "transport_failed" };
  }

  return { kind: "printed", bytes };
}
