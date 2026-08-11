import type { StationClient } from "./api-client.js";
import type { StationConfig } from "./config.js";

interface StationIdentity {
  device: {
    id: string;
    name: string;
    tenantId: string;
    organizationName: string;
    line: { id: string; name: string } | null;
  };
  subscription?: {
    access: "managed" | "read_only" | "unmanaged";
    status: "unmanaged" | "pending_activation" | "trial" | "active" | "expired" | "read_only";
    startsAt: string | null;
    endsAt: string | null;
  };
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodeStationIdentity(value: unknown): StationIdentity | null {
  if (!exactRecordWithOptional(value, ["device"], ["subscription"])) return null;
  const device = value.device;
  if (
    !exactRecord(device, ["id", "line", "name", "organizationName", "tenantId"]) ||
    !nonEmptyString(device.id) ||
    !nonEmptyString(device.name) ||
    !nonEmptyString(device.tenantId) ||
    !nonEmptyString(device.organizationName)
  ) {
    return null;
  }
  if (value.subscription !== undefined && !subscriptionAccess(value.subscription)) return null;
  const line = device.line;
  let decodedLine: { id: string; name: string } | null = null;
  if (line !== null) {
    if (
      !exactRecord(line, ["id", "name"]) ||
      !nonEmptyString(line.id) ||
      !nonEmptyString(line.name)
    ) {
      return null;
    }
    decodedLine = { id: line.id, name: line.name };
  }
  return {
    device: {
      id: device.id,
      name: device.name,
      tenantId: device.tenantId,
      organizationName: device.organizationName,
      line: decodedLine,
    },
    ...(value.subscription !== undefined ? { subscription: value.subscription } : {}),
  };
}

function subscriptionAccess(value: unknown): value is NonNullable<StationIdentity["subscription"]> {
  return (
    exactRecord(value, ["access", "status", "startsAt", "endsAt"]) &&
    typeof value.access === "string" &&
    ["managed", "read_only", "unmanaged"].includes(value.access) &&
    typeof value.status === "string" &&
    ["unmanaged", "pending_activation", "trial", "active", "expired", "read_only"].includes(
      value.status,
    ) &&
    nullableTimestamp(value.startsAt) &&
    nullableTimestamp(value.endsAt)
  );
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function exactRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => key in value) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

/**
 * Resolves the config a pre-deviceId station may atomically persist only after
 * the existing key proves its own durable server-side station row. The caller
 * owns the generation check and serialized write boundary.
 */
export async function resolveLegacyStationIdentity(
  client: Pick<StationClient, "get">,
  config: StationConfig,
): Promise<StationConfig> {
  if (!config.apiKey || !config.serverUrl || config.deviceId) {
    throw new Error("legacy station identity backfill precondition failed");
  }
  const identity = decodeStationIdentity(await client.get<unknown>("/station/identity"));
  if (!identity) throw new Error("invalid station identity response");
  const next: StationConfig = {
    machineId: config.machineId,
    deviceId: identity.device.id,
    tenantId: identity.device.tenantId,
    deviceName: identity.device.name,
    organizationName: identity.device.organizationName,
    apiKey: config.apiKey,
    serverUrl: config.serverUrl,
    ...(identity.device.line
      ? { lineId: identity.device.line.id, lineName: identity.device.line.name }
      : {}),
  };
  return next;
}
