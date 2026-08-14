import {
  STORE_BOX_REGISTRY_ACTIVE,
  STORE_BOX_REGISTRY_META,
  STORE_BOX_REGISTRY_STAGING,
  STORE_CONFIG,
  withStore,
  withTransaction,
} from "./db.js";
import {
  boxRegistryBindingOf,
  boxRegistryCredentialOwnerOf,
  credentialGenerationOf,
  sameBoxRegistryBinding,
  sameBoxRegistryCredentialOwner,
} from "./installation-binding.js";

const KEY = "current";
const SCANNER_KEY = "scanner";

/** Device identity and settings: server URL, device token, which kiosk the
 * device is bound to (id, name, place), and the next `deviceSeq` to use for a
 * queued order. */
export interface KioskConfig {
  serverUrl: string;
  token: string | null;
  /**
   * WHICH KIOSK ROW THIS DEVICE IS BOUND TO — `PairKioskResultDto.device.kioskId`,
   * recorded at the one moment it is established.
   *
   * Not cosmetic, unlike `kioskName` and `place` beside it: it is the identity
   * the SERVER files this device's orders under, and therefore the identity its
   * day-limit figure excludes when it reports what a worker took at every OTHER
   * kiosk (`employees[].takenTodayElsewhere`). The device's own half of that sum
   * is counted out of a journal that belongs to the DEVICE, so without this the
   * two halves are keyed on different things and a re-paired tablet counts its
   * old gate's orders in both — see `countTakenToday`.
   *
   * `null` on a config written before this field existed, which reads as "this
   * device cannot say which kiosk it is", and is deliberately the same answer an
   * unstamped journal entry gives. Any pairing writes a real id.
   */
  kioskId: string | null;
  kioskName: string;
  place: string | null;
  nextDeviceSeq: number;
  /** Non-secret owner generation rotated whenever the paired token changes. */
  credentialGeneration?: string | null;
}

/**
 * The kiosk id a stored record names, checked rather than trusted — the ONE
 * rule for what counts as a kiosk identity on this device.
 *
 * Shared by the two records that have to agree: the config's binding and the
 * stamp on a journal entry. They are compared for equality, so a single rule is
 * what keeps `undefined` (a record from an older build), `""` and a stray
 * non-string from being three different kinds of "unknown" that fail to match
 * each other — or, worse, match a real gate.
 */
export function kioskIdOf(value: unknown): string | null {
  const id = (value as { kioskId?: unknown } | null | undefined)?.kioskId;
  return typeof id === "string" && id !== "" ? id : null;
}

export async function readConfig(): Promise<KioskConfig | null> {
  const found = await withStore<KioskConfig>(STORE_CONFIG, "readonly", (s) => s.get(KEY));
  if (!found) return null;
  // Normalised HERE so every caller — and every record written back through a
  // spread of this one — carries the field in the shape the type promises,
  // whatever the build that first wrote the record put there.
  const normalized = { ...found, kioskId: kioskIdOf(found) };
  if (normalized.token && !credentialGenerationOf(normalized)) return writeConfig(normalized);
  return normalized;
}

export async function writeConfig(cfg: KioskConfig): Promise<KioskConfig> {
  const freshCredentialGeneration = crypto.randomUUID();
  let stored: KioskConfig | null = null;
  await withTransaction(
    [STORE_CONFIG, STORE_BOX_REGISTRY_ACTIVE, STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      const config = tx.objectStore(STORE_CONFIG);
      const meta = tx.objectStore(STORE_BOX_REGISTRY_META);
      const previousRequest = config.get(KEY);
      const activeMetaRequest = meta.get("active");
      let ready = 0;
      const apply = () => {
        ready += 1;
        if (ready !== 2) return;
        const previousBinding = boxRegistryBindingOf(previousRequest.result);
        const nextBinding = boxRegistryBindingOf(cfg);
        const previous = previousRequest.result as Partial<KioskConfig> | undefined;
        const tokenRotated = previous?.token !== cfg.token;
        const credentialGeneration =
          cfg.token === null
            ? null
            : !tokenRotated && sameBoxRegistryBinding(previousBinding, nextBinding)
              ? (credentialGenerationOf(previous) ?? freshCredentialGeneration)
              : freshCredentialGeneration;
        stored = { ...cfg, credentialGeneration };
        const nextCredentialOwner = boxRegistryCredentialOwnerOf(stored);
        const activeCredentialOwner = boxRegistryCredentialOwnerOf(activeMetaRequest.result);
        const mustClear =
          cfg.token === null ||
          tokenRotated ||
          nextBinding === null ||
          !sameBoxRegistryBinding(previousBinding, nextBinding) ||
          (activeMetaRequest.result !== undefined &&
            !sameBoxRegistryCredentialOwner(activeCredentialOwner, nextCredentialOwner));
        if (mustClear) {
          tx.objectStore(STORE_BOX_REGISTRY_ACTIVE).clear();
          tx.objectStore(STORE_BOX_REGISTRY_STAGING).clear();
          meta.clear();
        }
        config.put(stored, KEY);
      };
      previousRequest.onsuccess = apply;
      activeMetaRequest.onsuccess = apply;
    },
  );
  if (!stored) throw new Error("kiosk config transaction did not store a value");
  return stored;
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
