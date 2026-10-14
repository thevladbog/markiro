/**
 * The printer form of the workstation setup: what the operator types, and
 * the profile it describes once checked.
 */
import type { PrintTarget } from "../../hardware/hardware.js";
import {
  parsePrinterProfile,
  printerMode,
  type PrinterDpi,
  type PrinterLanguage,
  type PrinterMode,
  type PrinterProfile,
} from "./workstation-settings.js";

/** How the printer is connected. */
export type Kind = PrintTarget["kind"];

/** The printer form, as typed: numbers stay text until the form is checked. */
export interface PrinterDraft {
  /** The profile being changed; `null` — a new one. */
  id: string | null;
  name: string;
  /**
   * The name is one the form made (the next free «Принтер N», or the Windows printer's name): it
   * follows the chosen printer until the operator types a name of their own.
   */
  nameAuto: boolean;
  kind: Kind;
  host: string;
  tcpPort: string;
  serialPort: string;
  baud: string;
  usbPrinter: string;
  language: PrinterLanguage;
  dpi: `${PrinterDpi}`;
  /** Read only for a Windows queue (plan ДРВ): another kind always prints RAW. */
  mode: PrinterMode;
  /** «Лист А4» (plan А4): only a Windows queue in driver mode, at 300 dpi. */
  paper: "label" | "a4";
}

export const NEW_PRINTER: PrinterDraft = {
  id: null,
  name: "",
  nameAuto: true,
  kind: "tcp",
  host: "",
  tcpPort: "9100",
  serialPort: "",
  baud: "9600",
  usbPrinter: "",
  language: "zpl",
  dpi: "203",
  mode: "raw",
  paper: "label",
};

export function draftOf(profile: PrinterProfile): PrinterDraft {
  const { target } = profile;
  return {
    ...NEW_PRINTER,
    id: profile.id,
    name: profile.name,
    nameAuto: false,
    kind: target.kind,
    host: target.kind === "tcp" ? target.host : "",
    tcpPort: target.kind === "tcp" ? String(target.port) : NEW_PRINTER.tcpPort,
    serialPort: target.kind === "serial" ? target.port : "",
    baud: target.kind === "serial" ? String(target.baud) : NEW_PRINTER.baud,
    usbPrinter: target.kind === "usb" ? target.printer : "",
    language: profile.language,
    dpi: profile.dpi === 300 ? "300" : "203",
    mode: printerMode(profile),
    paper: profile.paper ?? "label",
  };
}

/** «Принтер N» with the smallest N that no printer of the list bears yet. */
export function nextPrinterName(taken: readonly string[], prefix: string): string {
  const used = new Set(taken.map((name) => name.trim()));
  let n = 1;
  while (used.has(`${prefix} ${n}`)) n += 1;
  return `${prefix} ${n}`;
}

/** The form of a new printer, already named (see `nextPrinterName`). */
export function newPrinterDraft(taken: readonly string[], prefix: string): PrinterDraft {
  return { ...NEW_PRINTER, name: nextPrinterName(taken, prefix) };
}

/**
 * The draft after a change, kept consistent (plan А4): A4 paper is the 300 dpi
 * of a Windows queue in driver mode, so choosing it sets 300 dpi and leaving
 * the driver (another way of connecting or printing) goes back to the label
 * paper, instead of leaving a hidden choice that the check would refuse.
 */
export function settleDraft(draft: PrinterDraft, patch: Partial<PrinterDraft>): PrinterDraft {
  let next = { ...draft, ...patch };
  // Typing a name takes it over from the form; choosing a Windows printer names the form's own name.
  if (patch.name !== undefined && patch.nameAuto === undefined) next = { ...next, nameAuto: false };
  if (patch.usbPrinter !== undefined && patch.usbPrinter !== "" && next.nameAuto) {
    next = { ...next, name: patch.usbPrinter };
  }
  if (!(next.kind === "usb" && next.mode === "windows_driver")) return { ...next, paper: "label" };
  return next.paper === "a4" ? { ...next, dpi: "300" } : next;
}

/** The keys of `floor.setup.printers.errors`. */
export type DraftError = "name" | "host" | "port" | "serialPort" | "baud" | "usbPrinter" | "paper";

function wholeNumber(text: string): number | null {
  return /^[0-9]+$/.test(text.trim()) ? Number(text.trim()) : null;
}

/**
 * The profile a draft describes, or the first thing wrong with it. The
 * driver's mode is written only for a Windows queue; RAW is no field at all,
 * as every profile before plan ДРВ; so is the label paper before plan А4.
 */
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
  const driver = draft.kind === "usb" && draft.mode === "windows_driver";
  // «Лист А4» is a driver page at 300 dpi and nothing else (plan А4).
  if (draft.paper === "a4" && !(driver && draft.dpi === "300")) return { error: "paper" };
  const profile = parsePrinterProfile({
    id: draft.id ?? newId(),
    name: draft.name,
    target,
    language: draft.language,
    dpi: Number(draft.dpi),
    ...(driver ? { mode: "windows_driver" } : {}),
    ...(draft.paper === "a4" ? { paper: "a4" } : {}),
  });
  return profile === null ? { error: "name" } : { profile };
}
