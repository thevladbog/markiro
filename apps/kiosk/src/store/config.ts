import { STORE_CONFIG, withStore } from "./db.js";

const KEY = "current";

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
