import { invoke } from "@tauri-apps/api/core";

/**
 * Webview view of the Rust StationConfig. The Rust struct uses snake_case
 * (machine_id, tenant_id, ...); serde serializes those field names across
 * the IPC boundary, so this bridge maps to/from camelCase explicitly rather
 * than assuming a rename attribute exists on the Rust side.
 */
export interface StationConfig {
  machineId: string;
  tenantId?: string;
  deviceId?: string;
  apiKey?: string;
  serverUrl?: string;
}

interface RustConfig {
  machine_id: string;
  tenant_id?: string;
  device_id?: string;
  api_key?: string;
  server_url?: string;
}

// Built via conditional spreads (not direct field assignment) because the
// repo's `exactOptionalPropertyTypes` rejects assigning a `string | undefined`
// value to an optional `string` property — an absent Rust field must be an
// absent TS property, not a present one holding `undefined` (same discipline
// as `src/i18n/index.ts`'s `missingKeyOptions`).
function fromRust(c: RustConfig): StationConfig {
  return {
    machineId: c.machine_id,
    ...(c.tenant_id !== undefined ? { tenantId: c.tenant_id } : {}),
    ...(c.device_id !== undefined ? { deviceId: c.device_id } : {}),
    ...(c.api_key !== undefined ? { apiKey: c.api_key } : {}),
    ...(c.server_url !== undefined ? { serverUrl: c.server_url } : {}),
  };
}

function toRust(c: StationConfig): RustConfig {
  return {
    machine_id: c.machineId,
    ...(c.tenantId !== undefined ? { tenant_id: c.tenantId } : {}),
    ...(c.deviceId !== undefined ? { device_id: c.deviceId } : {}),
    ...(c.apiKey !== undefined ? { api_key: c.apiKey } : {}),
    ...(c.serverUrl !== undefined ? { server_url: c.serverUrl } : {}),
  };
}

export async function readConfig(): Promise<StationConfig> {
  return fromRust(await invoke<RustConfig>("read_config"));
}

export async function writeConfig(cfg: StationConfig): Promise<void> {
  await invoke("write_config", { cfg: toRust(cfg) });
}

/**
 * True once the device is enrolled (has a device key and server URL). The
 * api-key implies the tenant server-side (Better Auth resolves it from the
 * key's `referenceId`) — the station has no use for the raw org id in 05a,
 * and `Enrollment` never persists `tenantId`, so requiring it here would
 * strand a successfully enrolled device back on the enrollment screen.
 */
export function isEnrolled(cfg: StationConfig): boolean {
  return Boolean(cfg.apiKey && cfg.serverUrl);
}
