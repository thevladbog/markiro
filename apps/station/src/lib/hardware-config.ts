import type { PrintTarget } from "./hardware.js";
import type { SqlExecutor } from "./mirror.js";

/** The printer's command language. PDF output is a later slice. */
export type PrinterLanguage = "zpl" | "tspl";

/**
 * Everything the workstation setup screen configures once. Held on the
 * station (not the server) so the device configures and runs offline; the
 * hardware contract stays stateless and receives these values per call.
 */
export interface SerialScannerConfig {
  port: string;
  baud: number;
}

export interface HardwareConfig {
  /** Legacy first port, retained for existing settings and older Station builds. */
  scanner: SerialScannerConfig | null;
  /** Authoritative when present, including an empty list. Stored locally/offline. */
  scanners?: SerialScannerConfig[];
  printer: PrintTarget | null;
  printerLanguage: PrinterLanguage;
  /** Absent in legacy settings; duplicate printing requires a known matching resolution. */
  printerDpi?: 203 | 300 | null;
  /**
   * Opt-in per workstation: after a box closes and prints, require the
   * operator to scan the printed label back before moving on. Off by
   * default -- the one place a scan verdict is deliberately allowed to
   * compete with the ordinary scan loop, so a station must be told to turn
   * it on rather than have it appear unannounced.
   */
  verifyPrintedLabel: boolean;
}

export const DEFAULT_HARDWARE_CONFIG: HardwareConfig = {
  scanner: null,
  printer: null,
  printerLanguage: "zpl",
  printerDpi: null,
  verifyPrintedLabel: false,
};

const META_KEY = "hardware_config";

/** COM names are case insensitive; POSIX paths are not. */
export function canonicalScannerPort(port: string): string {
  const trimmed = port.trim();
  return /^com[0-9]+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

function parseScanner(value: unknown): SerialScannerConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const { port, baud = 9600 } = value as { port?: unknown; baud?: unknown };
  if (typeof port !== "string" || !port.trim() || port.includes("\0")) return null;
  if (typeof baud !== "number" || !Number.isInteger(baud) || baud < 1 || baud > 4294967295)
    return null;
  return { port: canonicalScannerPort(port), baud };
}

export function configuredScanners(
  config: Pick<HardwareConfig, "scanner" | "scanners">,
): SerialScannerConfig[] {
  return config.scanners ?? (config.scanner ? [config.scanner] : []);
}

function parseScanners(values: unknown[]): SerialScannerConfig[] {
  const scanners: SerialScannerConfig[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const scanner = parseScanner(value);
    if (!scanner || seen.has(scanner.port)) continue;
    scanners.push(scanner);
    seen.add(scanner.port);
  }
  return scanners;
}

function parsePrinter(value: unknown): PrintTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as {
    kind?: unknown;
    port?: unknown;
    baud?: unknown;
    host?: unknown;
    printer?: unknown;
  };
  if (t.kind === "serial" && typeof t.port === "string" && t.port.length > 0) {
    return { kind: "serial", port: t.port, baud: typeof t.baud === "number" ? t.baud : 9600 };
  }
  if (t.kind === "tcp" && typeof t.host === "string" && t.host.length > 0) {
    return { kind: "tcp", host: t.host, port: typeof t.port === "number" ? t.port : 9100 };
  }
  if (t.kind === "usb" && typeof t.printer === "string" && t.printer.trim().length > 0) {
    return { kind: "usb", printer: t.printer };
  }
  return null;
}

/**
 * Reads the stored configuration, falling back to defaults for anything
 * missing or malformed. Never rejects: this runs at boot and can race the
 * migration that creates `station_meta`, and a station that cannot read a
 * preference must still come up and validate codes.
 */
export async function loadHardwareConfig(exec: SqlExecutor): Promise<HardwareConfig> {
  try {
    const rows = await exec.all<{ value: string | null }>(
      "SELECT value FROM station_meta WHERE key = ?",
      [META_KEY],
    );
    const raw = rows[0]?.value;
    if (!raw) return { ...DEFAULT_HARDWARE_CONFIG };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const scanners = Array.isArray(parsed.scanners) ? parseScanners(parsed.scanners) : undefined;
    return {
      scanner: scanners ? (scanners[0] ?? null) : parseScanner(parsed.scanner),
      ...(scanners ? { scanners } : {}),
      printer: parsePrinter(parsed.printer),
      printerLanguage: parsed.printerLanguage === "tspl" ? "tspl" : "zpl",
      printerDpi: parsed.printerDpi === 203 || parsed.printerDpi === 300 ? parsed.printerDpi : null,
      verifyPrintedLabel: parsed.verifyPrintedLabel === true,
    };
  } catch {
    return { ...DEFAULT_HARDWARE_CONFIG };
  }
}

export async function saveHardwareConfig(exec: SqlExecutor, config: HardwareConfig): Promise<void> {
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [META_KEY, JSON.stringify({ ...config, scanner: configuredScanners(config)[0] ?? null })],
  );
}
