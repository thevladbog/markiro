import type { HardwareConfig, PrinterLanguage } from "./hardware-config.js";
import type { PrintTarget } from "./hardware.js";

export const PRINT_PURPOSES = ["box", "duplicate", "pallet"] as const;
export type PrintPurpose = (typeof PRINT_PURPOSES)[number];
export interface PrinterProfile {
  id: string;
  name: string;
  target: PrintTarget;
  language: PrinterLanguage;
  dpi: 203 | 300 | null;
}
export interface PrinterRouting {
  printers: PrinterProfile[];
  assignments: Record<PrintPurpose, string | null>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !value.includes("\0") ? value.trim() : null;
}

export function parsePrintTarget(value: unknown): PrintTarget | null {
  const target = record(value);
  if (!target) return null;
  if (target.kind === "tcp") {
    const host = text(target.host);
    const port = target.port;
    return host && typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535
      ? { kind: "tcp", host, port }
      : null;
  }
  if (target.kind === "usb") {
    const printer = text(target.printer);
    return printer ? { kind: "usb", printer } : null;
  }
  if (target.kind === "serial") {
    const port = text(target.port);
    const baud = target.baud;
    return port &&
      typeof baud === "number" &&
      Number.isInteger(baud) &&
      baud > 0 &&
      baud <= 4294967295
      ? { kind: "serial", port: /^com\d+$/i.test(port) ? port.toUpperCase() : port, baud }
      : null;
  }
  return null;
}

/** Physical endpoint, independent of role and rendering settings. */
export function printerTargetKey(target: PrintTarget): string {
  switch (target.kind) {
    case "tcp":
      return JSON.stringify([
        "tcp",
        target.host.trim().toLowerCase().replace(/\.$/, ""),
        target.port,
      ]);
    case "serial": {
      const port = target.port.trim();
      return JSON.stringify(["serial", /^com\d+$/i.test(port) ? port.toUpperCase() : port]);
    }
    case "usb":
      return JSON.stringify(["usb", target.printer.trim().toLowerCase()]);
  }
}

export function parsePrinterProfile(value: unknown): PrinterProfile | null {
  const row = record(value);
  if (!row) return null;
  const id = text(row.id);
  const name = text(row.name);
  const target = parsePrintTarget(row.target);
  if (!id || !name || !target || (row.language !== "zpl" && row.language !== "tspl")) return null;
  if (row.dpi !== null && row.dpi !== 203 && row.dpi !== 300) return null;
  return { id, name, target, language: row.language, dpi: row.dpi };
}

/** An explicit malformed or empty routing is unconfigured, never a legacy fallback. */
export function parsePrinterRouting(value: unknown): PrinterRouting {
  const row = record(value);
  const printers: PrinterProfile[] = [];
  const byEndpoint = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const candidate of Array.isArray(row?.printers) ? row.printers : []) {
    const profile = parsePrinterProfile(candidate);
    if (!profile || aliases.has(profile.id)) continue;
    const key = printerTargetKey(profile.target);
    const existing = byEndpoint.get(key);
    aliases.set(profile.id, existing ?? profile.id);
    if (!existing) {
      printers.push(profile);
      byEndpoint.set(key, profile.id);
    }
  }
  const stored = record(row?.assignments);
  const assignments: PrinterRouting["assignments"] = { box: null, duplicate: null, pallet: null };
  for (const purpose of PRINT_PURPOSES) {
    const id = stored?.[purpose];
    assignments[purpose] = typeof id === "string" ? (aliases.get(id) ?? null) : null;
  }
  return { printers, assignments };
}

export function configuredPrinterRouting(config: HardwareConfig): PrinterRouting {
  if (config.printerRouting !== undefined) return parsePrinterRouting(config.printerRouting);
  const target = parsePrintTarget(config.printer);
  if (!target) return parsePrinterRouting(null);
  const id = `legacy:${printerTargetKey(target)}`;
  const name =
    target.kind === "tcp" ? target.host : target.kind === "serial" ? target.port : target.printer;
  return {
    printers: [
      { id, name, target, language: config.printerLanguage, dpi: config.printerDpi ?? null },
    ],
    assignments: { box: id, duplicate: id, pallet: id },
  };
}

export function resolvePrinter(
  config: HardwareConfig,
  purpose: PrintPurpose,
): PrinterProfile | null {
  const routing = configuredPrinterRouting(config);
  return routing.printers.find((printer) => printer.id === routing.assignments[purpose]) ?? null;
}

export function configuredPrinterOutput(
  config: HardwareConfig,
  purpose: PrintPurpose,
  print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>,
) {
  const profile = resolvePrinter(config, purpose);
  return profile ? { ...profile, profile, print } : null;
}

/** Compatibility for injected/legacy transport props; production callers pass the saved profile. */
export function outputPrinterProfile(output: {
  target: PrintTarget | null;
  language: PrinterLanguage;
  dpi?: 203 | 300 | null;
  profile?: PrinterProfile | null;
}): PrinterProfile | null {
  if (output.profile !== undefined) return output.profile;
  if (!output.target) return null;
  const target = output.target;
  return {
    id: `legacy:${printerTargetKey(target)}`,
    name:
      target.kind === "tcp" ? target.host : target.kind === "serial" ? target.port : target.printer,
    target,
    language: output.language,
    dpi: output.dpi ?? null,
  };
}

const outputTails = new Map<string, Promise<void>>();
export async function serializePrinterOutput<T>(
  target: PrintTarget,
  send: () => Promise<T>,
): Promise<T> {
  const key = printerTargetKey(target);
  const previous = outputTails.get(key) ?? Promise.resolve();
  const result = previous.then(send);
  const settled = result.then(
    () => {},
    () => {},
  );
  outputTails.set(key, settled);
  try {
    return await result;
  } finally {
    if (outputTails.get(key) === settled) outputTails.delete(key);
  }
}
