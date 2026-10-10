import { z } from "zod";

import type { PrintTarget, ScannerConfig } from "../../hardware/hardware.js";
import type { LocalExecutor, LocalStatement } from "../../local/executor.js";

/**
 * What a printer prints for (stage 2a spec, decision 23): the box label, the
 * pallet label of the pallets' plan (ПЛ-Ц) and the code duplicate of stage 3.
 * All three are kept from plan 2a7 on, so the later plans add no migration of
 * the settings; plan 2a7 prints only `box`.
 */
export const PRINT_PURPOSES = ["box", "pallet", "duplicate"] as const;
export type PrintPurpose = (typeof PRINT_PURPOSES)[number];

/** The printer's command language. */
export const PRINTER_LANGUAGES = ["zpl", "tspl"] as const;
export type PrinterLanguage = (typeof PRINTER_LANGUAGES)[number];

/** The printer's resolution in dots per inch. */
export const PRINTER_DPIS = [203, 300] as const;
export type PrinterDpi = (typeof PRINTER_DPIS)[number];

/**
 * A printer of this workstation: where it is, its language and its
 * resolution. A job keeps a copy of the profile it was rendered for, so an
 * edit here never changes a label already prepared.
 */
export interface PrinterProfile {
  id: string;
  name: string;
  target: PrintTarget;
  language: PrinterLanguage;
  dpi: PrinterDpi;
}

/** The workstation's sound: the verdict tones' level, 0–100, or none at all. */
export interface SoundSettings {
  muted: boolean;
  volume: number;
}

/**
 * Everything the workstation setup configures (stage 2a spec §5.7.8). It
 * belongs to this computer, not to a pairing (`workstation_settings`,
 * `TableClass::Workstation`), and a forget keeps it.
 */
export interface WorkstationSettings {
  printers: PrinterProfile[];
  /** The printer of each purpose, by profile id; `null` — none. */
  assignments: Record<PrintPurpose, string | null>;
  scanners: ScannerConfig[];
  sound: SoundSettings;
  /** After a box label prints, its SSCC is scanned back before the work goes on. */
  verifyPrintedLabel: boolean;
}

export const DEFAULT_SOUND: SoundSettings = { muted: false, volume: 80 };

export const DEFAULT_WORKSTATION_SETTINGS: WorkstationSettings = {
  printers: [],
  assignments: { box: null, pallet: null, duplicate: null },
  scanners: [],
  sound: DEFAULT_SOUND,
  // Off, as the cloud's `DEFAULT_HARDWARE_CONFIG`: a station is told to check.
  verifyPrintedLabel: false,
};

/** The keys of `workstation_settings`: each is read on its own, so one bad value spoils only itself. */
export const SETTING_KEYS = {
  printers: "printers",
  scanners: "scanners",
  sound: "sound",
  verifyPrintedLabel: "verify_printed_label",
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\0")
    ? value.trim()
    : null;
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** The most COM scanners one set may name (`MAX_SCANNERS` of `src-tauri/src/scanner/runtime.rs`). */
export const MAX_SCANNERS = 32;

/** The longest port name, in characters (`MAX_PORT_NAME_CHARS` of the shell). */
export const MAX_PORT_NAME_CHARS = 256;

/**
 * A port name as the shell takes it: not empty, at most `MAX_PORT_NAME_CHARS`
 * characters, no control character (`char::is_control`: C0, DEL and C1). A set
 * with one name it refuses is refused as a whole, so every scanner would stay
 * closed: the webview never stores such a name.
 */
export function isPortName(port: string): boolean {
  if (port === "" || [...port].length > MAX_PORT_NAME_CHARS) return false;
  return ![...port].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

/** COM names are case-insensitive (`com3` is `COM3`); other port names are kept as they are. */
export function canonicalPort(port: string): string {
  const trimmed = port.trim();
  return /^com[0-9]+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

/** A print target as the shell takes it (`PrintTarget` of `src-tauri/src/printer.rs`), or `null`. */
export function parsePrintTarget(value: unknown): PrintTarget | null {
  const target = record(value);
  if (target === null) return null;
  if (target["kind"] === "tcp") {
    const host = text(target["host"]);
    const port = wholeNumber(target["port"], 1, 65_535);
    return host !== null && port !== null ? { kind: "tcp", host, port } : null;
  }
  if (target["kind"] === "serial") {
    const port = text(target["port"]);
    const baud = wholeNumber(target["baud"], 1, 4_294_967_295);
    return port !== null && baud !== null
      ? { kind: "serial", port: canonicalPort(port), baud }
      : null;
  }
  if (target["kind"] === "usb") {
    const printer = text(target["printer"]);
    return printer !== null ? { kind: "usb", printer } : null;
  }
  return null;
}

/**
 * The physical endpoint of a target, whatever it is used for: one address,
 * one queue of sends (`createPrinterQueue`), and one profile per address in
 * the settings.
 */
export function printerTargetKey(target: PrintTarget): string {
  switch (target.kind) {
    case "tcp":
      return JSON.stringify([
        "tcp",
        target.host.trim().toLowerCase().replace(/\.$/, ""),
        target.port,
      ]);
    case "serial":
      return JSON.stringify(["serial", canonicalPort(target.port)]);
    case "usb":
      return JSON.stringify(["usb", target.printer.trim().toLowerCase()]);
  }
}

/** A printer profile, or `null` for anything this build cannot print with. */
export function parsePrinterProfile(value: unknown): PrinterProfile | null {
  const row = record(value);
  if (row === null) return null;
  const id = text(row["id"]);
  const name = text(row["name"]);
  const target = parsePrintTarget(row["target"]);
  const language = PRINTER_LANGUAGES.find((candidate) => candidate === row["language"]);
  const dpi = PRINTER_DPIS.find((candidate) => candidate === row["dpi"]);
  if (id === null || name === null || target === null || !language || !dpi) return null;
  return { id, name, target, language, dpi };
}

/**
 * The printers and their purposes. A profile this build cannot read is
 * dropped; a second profile of an id already read, or of an address already
 * read, is dropped too and its purposes go to the first one (as the cloud's
 * `parsePrinterRouting`); a purpose naming no profile is unassigned — never a
 * guess.
 */
export function parsePrinters(
  value: unknown,
): Pick<WorkstationSettings, "printers" | "assignments"> {
  const row = record(value);
  const printers: PrinterProfile[] = [];
  const byEndpoint = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const candidate of Array.isArray(row?.["printers"]) ? row["printers"] : []) {
    const profile = parsePrinterProfile(candidate);
    if (profile === null || aliases.has(profile.id)) continue;
    const key = printerTargetKey(profile.target);
    const existing = byEndpoint.get(key);
    aliases.set(profile.id, existing ?? profile.id);
    if (existing === undefined) {
      printers.push(profile);
      byEndpoint.set(key, profile.id);
    }
  }
  const stored = record(row?.["assignments"]);
  const assignments: Record<PrintPurpose, string | null> = {
    box: null,
    pallet: null,
    duplicate: null,
  };
  for (const purpose of PRINT_PURPOSES) {
    const id = stored?.[purpose];
    assignments[purpose] = typeof id === "string" ? (aliases.get(id) ?? null) : null;
  }
  return { printers, assignments };
}

/** The COM scanners, each port once (`COM3` and `com3` are one), as `configure_scanners` takes them. */
export function parseScanners(value: unknown): ScannerConfig[] {
  const scanners: ScannerConfig[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(value) ? value : []) {
    const row = record(candidate);
    const port = text(row?.["port"]);
    const baud = wholeNumber(row?.["baud"], 1, 4_294_967_295);
    if (port === null || baud === null) continue;
    const canonical = canonicalPort(port);
    if (!isPortName(canonical) || seen.has(canonical)) continue;
    // The shell takes no more: the rest would make it refuse the whole set.
    if (scanners.length >= MAX_SCANNERS) break;
    seen.add(canonical);
    scanners.push({ port: canonical, baud });
  }
  return scanners;
}

/**
 * The COM port a serial printer and a scanner would both open, or `null`.
 * A scanner holds its port open for as long as it is configured, so a send to
 * a printer on that port could never get it, and the scanner would never
 * connect while the printer holds it: the two are never stored together.
 */
export function sharedSerialPort(
  printers: readonly PrinterProfile[],
  scanners: readonly ScannerConfig[],
): string | null {
  const scanned = new Set(scanners.map((scanner) => canonicalPort(scanner.port)));
  for (const printer of printers) {
    if (printer.target.kind !== "serial") continue;
    const port = canonicalPort(printer.target.port);
    if (scanned.has(port)) return port;
  }
  return null;
}

/** The sound settings; a value this build cannot read is the default. */
export function parseSound(value: unknown): SoundSettings {
  const row = record(value);
  const volume = wholeNumber(row?.["volume"], 0, 100);
  if (row === null || typeof row["muted"] !== "boolean" || volume === null) return DEFAULT_SOUND;
  return { muted: row["muted"], volume };
}

/** The gain of a verdict's tone: 0 when muted. */
export function soundLevel(sound: SoundSettings): number {
  return sound.muted ? 0 : sound.volume / 100;
}

const settingRow = z.object({ key: z.string(), value: z.string() });

function parsedValue(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * The workstation's settings as stored, each key read on its own: a key not
 * stored yet, or one this build cannot read, is its default, so one damaged
 * value never loses the others. A database that cannot be read rejects.
 */
export async function readWorkstationSettings(local: LocalExecutor): Promise<WorkstationSettings> {
  const rows = await local.query("SELECT key, value FROM workstation_settings", [], settingRow);
  const stored = new Map(rows.map((row) => [row.key, parsedValue(row.value)]));
  const verify = stored.get(SETTING_KEYS.verifyPrintedLabel);
  return {
    ...parsePrinters(stored.get(SETTING_KEYS.printers)),
    scanners: parseScanners(stored.get(SETTING_KEYS.scanners)),
    sound: parseSound(stored.get(SETTING_KEYS.sound)),
    verifyPrintedLabel: verify === true,
  };
}

/** A setting this build would not read back as it was given. */
export class InvalidSettingsError extends Error {
  constructor(what: string) {
    super(`workstation settings: ${what}`);
    this.name = "InvalidSettingsError";
  }
}

/** JSON with every object's keys in order, so two equal values compare equal as text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = record(value);
  if (row === null) return JSON.stringify(value);
  const keys = Object.keys(row).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
}

/** `value` survives `parse` unchanged. */
function readsBack(value: unknown, parse: (raw: unknown) => unknown): boolean {
  const raw: unknown = JSON.parse(JSON.stringify(value));
  return canonicalJson(parse(raw)) === canonicalJson(raw);
}

function upsert(key: string, value: unknown): LocalStatement {
  return {
    sql:
      "INSERT INTO workstation_settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    values: [key, JSON.stringify(value)],
    expectedChanges: 1,
  };
}

/**
 * Stores the settings in one transaction. What is stored is exactly what
 * `readWorkstationSettings` reads back: settings it would read otherwise (a
 * profile it would drop, a purpose naming no profile, a scanner twice, a port
 * name or a number of scanners the shell would refuse, one COM port for a
 * serial printer and a scanner) are refused with `InvalidSettingsError`
 * before anything is written.
 */
export async function saveWorkstationSettings(
  local: LocalExecutor,
  settings: WorkstationSettings,
): Promise<void> {
  const printers = { printers: settings.printers, assignments: settings.assignments };
  if (!readsBack(printers, parsePrinters)) throw new InvalidSettingsError("printers");
  if (!readsBack(settings.scanners, parseScanners)) throw new InvalidSettingsError("scanners");
  if (!readsBack(settings.sound, parseSound)) throw new InvalidSettingsError("sound");
  if (sharedSerialPort(settings.printers, settings.scanners) !== null) {
    throw new InvalidSettingsError("a port of a printer and of a scanner");
  }
  await local.transaction([
    upsert(SETTING_KEYS.printers, printers),
    upsert(SETTING_KEYS.scanners, settings.scanners),
    upsert(SETTING_KEYS.sound, settings.sound),
    upsert(SETTING_KEYS.verifyPrintedLabel, settings.verifyPrintedLabel),
  ]);
}

/** The printer assigned to `purpose`, or `null`. */
export function resolvePrinter(
  settings: Pick<WorkstationSettings, "printers" | "assignments">,
  purpose: PrintPurpose,
): PrinterProfile | null {
  const id = settings.assignments[purpose];
  return settings.printers.find((printer) => printer.id === id) ?? null;
}

/**
 * Gives the shell the COM scanners the settings name (an empty set closes
 * them all): when the app starts, and after the setup saves. A refusal or a
 * database that cannot be read is said by the answer, never thrown — the
 * keyboard scans either way, and the setup shows each port's connection.
 */
export async function applySavedScanners(
  local: LocalExecutor,
  configure: (scanners: readonly ScannerConfig[]) => Promise<void>,
): Promise<boolean> {
  try {
    const settings = await readWorkstationSettings(local);
    await configure(settings.scanners);
    return true;
  } catch {
    return false;
  }
}
