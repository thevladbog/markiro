import type { PrintTarget } from "./hardware.js";
import type { SqlExecutor } from "./mirror.js";

/** The printer's command language. PDF output is a later slice. */
export type PrinterLanguage = "zpl" | "tspl";

/**
 * Everything the workstation setup screen configures once. Held on the
 * station (not the server) so the device configures and runs offline; the
 * hardware contract stays stateless and receives these values per call.
 */
export interface HardwareConfig {
  /** null = no serial scanner; the keyboard wedge needs no configuration. */
  scanner: { port: string; baud: number } | null;
  printer: PrintTarget | null;
  printerLanguage: PrinterLanguage;
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
  verifyPrintedLabel: false,
};

const META_KEY = "hardware_config";

function parseScanner(value: unknown): HardwareConfig["scanner"] {
  if (typeof value !== "object" || value === null) return null;
  const { port, baud } = value as { port?: unknown; baud?: unknown };
  if (typeof port !== "string" || port.length === 0) return null;
  return { port, baud: typeof baud === "number" ? baud : 9600 };
}

function parsePrinter(value: unknown): PrintTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as { kind?: unknown; port?: unknown; baud?: unknown; host?: unknown };
  if (t.kind === "serial" && typeof t.port === "string" && t.port.length > 0) {
    return { kind: "serial", port: t.port, baud: typeof t.baud === "number" ? t.baud : 9600 };
  }
  if (t.kind === "tcp" && typeof t.host === "string" && t.host.length > 0) {
    return { kind: "tcp", host: t.host, port: typeof t.port === "number" ? t.port : 9100 };
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
    return {
      scanner: parseScanner(parsed.scanner),
      printer: parsePrinter(parsed.printer),
      printerLanguage: parsed.printerLanguage === "tspl" ? "tspl" : "zpl",
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
    [META_KEY, JSON.stringify(config)],
  );
}
