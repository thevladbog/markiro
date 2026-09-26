import { invoke } from "@tauri-apps/api/core";

import { deviceStatusSchema, type DeviceStatus } from "./protocol.js";

/** Codes the shell rejects device commands with (`DeviceError::code` in src-tauri). */
export const DEVICE_ERROR_CODES = [
  "config_unreadable",
  "storage",
  "not_paired",
  "already_paired",
  "unreachable",
  "not_markiro_host",
  "invalid_response",
  "host_too_old",
  "app_too_old",
  "certificate_mismatch",
  "invalid_request",
  "pair_rejected",
  "host_changed",
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];

export class DeviceError extends Error {
  readonly code: DeviceErrorCode;

  constructor(code: DeviceErrorCode, message: string) {
    super(message);
    this.name = "DeviceError";
    this.code = code;
  }
}

/** The pairing of this installation, kept by the shell (`device.json`). */
export interface DeviceApi {
  status(): Promise<DeviceStatus | null>;
  /** Pair with the host on this computer (`POST /v1/local-pair`, loopback only). */
  pairLocally(name: string): Promise<DeviceStatus>;
  /** Forget the pairing kept on this computer. */
  forget(): Promise<void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function createTauriDeviceApi(call: Invoke = invoke): DeviceApi {
  async function run(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(command, args);
    } catch (error) {
      const code = DEVICE_ERROR_CODES.find((candidate) => candidate === error) ?? "unreachable";
      throw new DeviceError(code, `${command}: ${String(error)}`);
    }
  }

  return {
    async status() {
      const raw = await run("device_status", {});
      return raw === null ? null : parseStatus(raw);
    },
    async pairLocally(name) {
      return parseStatus(await run("host_local_pair", { name }));
    },
    async forget() {
      await run("device_forget", {});
    },
  };
}

function parseStatus(raw: unknown): DeviceStatus {
  const parsed = deviceStatusSchema.safeParse(raw);
  if (!parsed.success) throw new DeviceError("invalid_response", parsed.error.message);
  return parsed.data;
}
