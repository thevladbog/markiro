import type { OperatorMirrorRecord } from "@markiro/db";
import { postUnauthenticatedStationRequest } from "./api-client.js";
import type { StationConfig } from "./config.js";
import { replaceOperatorsMirror, type SqlExecutor } from "./mirror.js";

export type PairingError =
  "invalid" | "expired" | "locked" | "rate_limited" | "unavailable" | "invalid_response";

export interface StationProvisioning {
  deviceId: string;
  deviceName: string;
  tenantId: string;
  organizationName: string;
  lineId?: string;
  lineName?: string;
  apiKey: string;
  serverUrl: string;
  operators: OperatorMirrorRecord[];
}

export type PairingResult =
  { ok: true; provisioning: StationProvisioning } | { ok: false; error: PairingError };

export interface ProvisioningPersistenceDependencies {
  machineId: string;
  exec: SqlExecutor;
  writeConfig: (config: StationConfig) => Promise<void>;
  /** Test-only/telemetry seam; normal callers signal only after this resolves. */
  onRosterPublished?: () => void;
}

const pairingErrors: Record<string, PairingError> = {
  PAIR_INVALID: "invalid",
  PAIR_EXPIRED: "expired",
  PAIR_LOCKED: "locked",
  PAIR_RATE_LIMITED: "rate_limited",
};

/** Redeems a short code without ever attaching an enrolled device key. */
export async function redeemStationPairing(
  serverUrl: string,
  code: string,
): Promise<PairingResult> {
  if (!/^\d{8}$/.test(code)) return { ok: false, error: "invalid" };

  try {
    const response = await postUnauthenticatedStationRequest(serverUrl, "/station/pair", { code });
    const body = await readJson(response);
    if (!response.ok) return { ok: false, error: pairingErrorFrom(body) };

    const provisioning = decodeProvisioning(body);
    return provisioning ? { ok: true, provisioning } : { ok: false, error: "invalid_response" };
  } catch {
    // Network and parsing failures share one public state. In particular do
    // not include a server body here: a successful provisioning response
    // contains the device key.
    return { ok: false, error: "unavailable" };
  }
}

/**
 * Makes a redeemed station usable in the only safe order. The mirror publisher
 * writes the inactive slot and flips it atomically; the Tauri config writer
 * atomically replaces its file. We intentionally do not clear journals or
 * other operational tables on either failure path.
 */
export async function persistStationProvisioning(
  provisioning: StationProvisioning,
  { machineId, exec, writeConfig, onRosterPublished }: ProvisioningPersistenceDependencies,
): Promise<void> {
  await replaceOperatorsMirror(exec, provisioning.operators);
  onRosterPublished?.();
  await writeConfig({
    machineId,
    deviceId: provisioning.deviceId,
    deviceName: provisioning.deviceName,
    tenantId: provisioning.tenantId,
    organizationName: provisioning.organizationName,
    ...(provisioning.lineId !== undefined ? { lineId: provisioning.lineId } : {}),
    ...(provisioning.lineName !== undefined ? { lineName: provisioning.lineName } : {}),
    apiKey: provisioning.apiKey,
    serverUrl: provisioning.serverUrl,
  });
}

function pairingErrorFrom(body: unknown): PairingError {
  if (isRecord(body) && typeof body.code === "string") {
    return pairingErrors[body.code] ?? "invalid";
  }
  return "unavailable";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Strictly decodes the public provisioning DTO before a roster or config
 * write. A partial response must never leave the station half-paired.
 */
function decodeProvisioning(value: unknown): StationProvisioning | null {
  if (!isExactRecord(value, ["device", "credential", "operators"])) return null;
  const { device, credential, operators } = value;
  if (!isExactRecord(device, ["id", "name", "tenantId", "organizationName", "line"])) return null;
  if (!isExactRecord(credential, ["apiKey", "serverUrl"])) return null;
  if (
    !isNonEmptyString(device.id) ||
    !isNonEmptyString(device.name) ||
    !isNonEmptyString(device.tenantId) ||
    !isNonEmptyString(device.organizationName) ||
    !isNonEmptyString(credential.apiKey) ||
    !isHttpsOrHttpUrl(credential.serverUrl) ||
    !Array.isArray(operators) ||
    !operators.every(isOperator)
  ) {
    return null;
  }

  let lineId: string | undefined;
  let lineName: string | undefined;
  if (device.line !== null) {
    if (
      !isExactRecord(device.line, ["id", "name"]) ||
      !isNonEmptyString(device.line.id) ||
      !isNonEmptyString(device.line.name)
    ) {
      return null;
    }
    lineId = device.line.id;
    lineName = device.line.name;
  }

  return {
    deviceId: device.id,
    deviceName: device.name,
    tenantId: device.tenantId,
    organizationName: device.organizationName,
    ...(lineId !== undefined ? { lineId } : {}),
    ...(lineName !== undefined ? { lineName } : {}),
    apiKey: credential.apiKey,
    serverUrl: credential.serverUrl,
    operators,
  };
}

function isOperator(value: unknown): value is OperatorMirrorRecord {
  return (
    isExactRecord(value, [
      "operatorId",
      "name",
      "login",
      "role",
      "pinHash",
      "badgeHash",
      "active",
    ]) &&
    isNonEmptyString(value.operatorId) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.login) &&
    isNonEmptyString(value.role) &&
    isNonEmptyString(value.pinHash) &&
    (value.badgeHash === null || isNonEmptyString(value.badgeHash)) &&
    typeof value.active === "boolean"
  );
}

function isHttpsOrHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}
