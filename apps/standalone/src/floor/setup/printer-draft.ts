/**
 * The printer form of the workstation setup: what the operator types, and
 * the profile it describes once checked.
 */
import type { PrintTarget } from "../../hardware/hardware.js";
import {
  parsePrinterProfile,
  type PrinterDpi,
  type PrinterLanguage,
  type PrinterProfile,
} from "./workstation-settings.js";

/** How the printer is connected. */
export type Kind = PrintTarget["kind"];

/** The printer form, as typed: numbers stay text until the form is checked. */
export interface PrinterDraft {
  /** The profile being changed; `null` — a new one. */
  id: string | null;
  name: string;
  kind: Kind;
  host: string;
  tcpPort: string;
  serialPort: string;
  baud: string;
  usbPrinter: string;
  language: PrinterLanguage;
  dpi: `${PrinterDpi}`;
}

export const NEW_PRINTER: PrinterDraft = {
  id: null,
  name: "",
  kind: "tcp",
  host: "",
  tcpPort: "9100",
  serialPort: "",
  baud: "9600",
  usbPrinter: "",
  language: "zpl",
  dpi: "203",
};

export function draftOf(profile: PrinterProfile): PrinterDraft {
  const { target } = profile;
  return {
    ...NEW_PRINTER,
    id: profile.id,
    name: profile.name,
    kind: target.kind,
    host: target.kind === "tcp" ? target.host : "",
    tcpPort: target.kind === "tcp" ? String(target.port) : NEW_PRINTER.tcpPort,
    serialPort: target.kind === "serial" ? target.port : "",
    baud: target.kind === "serial" ? String(target.baud) : NEW_PRINTER.baud,
    usbPrinter: target.kind === "usb" ? target.printer : "",
    language: profile.language,
    dpi: profile.dpi === 300 ? "300" : "203",
  };
}

/** The keys of `floor.setup.printers.errors`. */
export type DraftError = "name" | "host" | "port" | "serialPort" | "baud" | "usbPrinter";

function wholeNumber(text: string): number | null {
  return /^[0-9]+$/.test(text.trim()) ? Number(text.trim()) : null;
}

/** The profile a draft describes, or the first thing wrong with it. */
export function profileOf(
  draft: PrinterDraft,
  newId: () => string,
): { profile: PrinterProfile } | { error: DraftError } {
  if (draft.name.trim() === "") return { error: "name" };
  let target: PrintTarget;
  if (draft.kind === "tcp") {
    const port = wholeNumber(draft.tcpPort);
    if (draft.host.trim() === "") return { error: "host" };
    if (port === null || port < 1 || port > 65_535) return { error: "port" };
    target = { kind: "tcp", host: draft.host.trim(), port };
  } else if (draft.kind === "serial") {
    const baud = wholeNumber(draft.baud);
    if (draft.serialPort.trim() === "") return { error: "serialPort" };
    if (baud === null || baud < 1 || baud > 4_294_967_295) return { error: "baud" };
    target = { kind: "serial", port: draft.serialPort, baud };
  } else {
    if (draft.usbPrinter.trim() === "") return { error: "usbPrinter" };
    target = { kind: "usb", printer: draft.usbPrinter };
  }
  const profile = parsePrinterProfile({
    id: draft.id ?? newId(),
    name: draft.name,
    target,
    language: draft.language,
    dpi: Number(draft.dpi),
  });
  return profile === null ? { error: "name" } : { profile };
}
