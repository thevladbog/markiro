import { STORE_CONFIG, withStore } from "./db.js";

const KEY = "current";
const SCANNER_KEY = "scanner";

/** Device identity and settings: server URL, device token, kiosk name/place,
 * and the next `deviceSeq` to use for a queued order. */
export interface KioskConfig {
  serverUrl: string;
  token: string | null;
  kioskName: string;
  place: string | null;
  nextDeviceSeq: number;
}

export async function readConfig(): Promise<KioskConfig | null> {
  const found = await withStore<KioskConfig>(STORE_CONFIG, "readonly", (s) => s.get(KEY));
  return found ?? null;
}

export async function writeConfig(cfg: KioskConfig): Promise<void> {
  await withStore(STORE_CONFIG, "readwrite", (s) => s.put(cfg, KEY));
}

/** Which transport the scanner-setup screen was told to use. */
export interface ScannerSettings {
  transport: "keyboard" | "serial";
}

/**
 * The scanner transport lives under its OWN key in the same generically-keyed
 * `STORE_CONFIG` store, deliberately NOT inside `KioskConfig` and deliberately
 * without a schema-version bump (the store already exists; nothing new is
 * created):
 *
 *  - an UNPAIRED device has no `KioskConfig` at all, yet it is exactly the
 *    device that needs this setting — the scanner is usually what reads the
 *    pairing code off the admin panel. Folding the transport into
 *    `KioskConfig` would make it unwritable in the pre-pairing tier, which is
 *    the tier that needs it most;
 *  - the two records also have different lifetimes: re-pairing rewrites
 *    `KioskConfig` wholesale, and it must not take the installer's hardware
 *    choice down with it.
 *
 * Only the MODE is stored. A Web Serial *port grant* cannot be persisted here
 * — the `SerialPort` handle is not structured-cloneable and the grant itself
 * belongs to the browser's permission store. On boot the granted port is
 * recovered via `navigator.serial.getPorts()`, which Task 14 wires; this
 * module stores the mode alone.
 */
export async function readScannerSettings(): Promise<ScannerSettings | null> {
  const found = await withStore<ScannerSettings>(STORE_CONFIG, "readonly", (s) =>
    s.get(SCANNER_KEY),
  );
  return found ?? null;
}

export async function writeScannerSettings(settings: ScannerSettings): Promise<void> {
  await withStore(STORE_CONFIG, "readwrite", (s) => s.put(settings, SCANNER_KEY));
}
