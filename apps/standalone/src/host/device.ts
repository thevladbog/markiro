import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

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
  "pairing_code_invalid",
  "pairing_code_expired",
  "rate_limited",
  "line_rejected",
  "key_rejected",
  "request_failed",
  "unsent_facts",
  "address_other_host",
  // The site's license refused the pairing (plan ЛЦ-3): no seat left, or not this kind of device.
  "seat_limit",
  "feature_disabled",
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

/**
 * What `host_claim` needs: the host's address, its certificate fingerprint
 * (from the scanned pairing code, or compared by a person with the office
 * screen), the one-time code and this device's name.
 */
export interface ClaimInput {
  address: string;
  fingerprint: string;
  code: string;
  name: string;
  /**
   * The person chose «новое устройство» on a pairing screen that was waiting
   * to pair this station again as the device it was: the claim names no
   * device and the code is an ordinary one.
   */
  asNew?: boolean;
}

/**
 * The role the installer gave this computer (`installation.json`, plan УСТ):
 * «хост и станция», «только станция», «только офис». `null` in a development
 * build, which works as a station.
 */
export const installRoleSchema = z.enum(["host", "station", "office"]).nullable();
export type InstallRole = z.infer<typeof installRoleSchema>;

/** The pairing of this installation, kept by the shell (`device.json`). */
export interface DeviceApi {
  status(): Promise<DeviceStatus | null>;
  /** Pair with the host on this computer (`POST /v1/local-pair`, loopback only). */
  pairLocally(name: string): Promise<DeviceStatus>;
  /** Pair with a host in the network by a one-time code from the office (`host_claim`). */
  claim(input: ClaimInput): Promise<DeviceStatus>;
  /** Choose this station's line; the shell keeps the host's answer in `device.json`. */
  selectLine(lineId: string): Promise<DeviceStatus>;
  /**
   * Forget the pairing kept on this computer. While this pairing has shift
   * records the host has not acknowledged, the shell refuses with
   * `unsent_facts`; `keepUnsent: true` goes ahead anyway (a person confirmed
   * it), and the records stay on this PC's disk. `repair: true` is the forget
   * of a rejected or moved device («Подключить заново»): the shell keeps the
   * device's ids so the office's code for that device re-pairs the same device.
   */
  forget(options?: { keepUnsent?: boolean; repair?: boolean }): Promise<void>;
  /**
   * Whether this station waits to be paired again as the device it was
   * (`device_repair_pending`): set by a `repair` forget, cleared by the next
   * pairing. The code that pairs it is the one the office makes on the
   * Devices page for that device.
   */
  repairPending(): Promise<boolean>;
  /**
   * Read this device's record from the host again (`device_refresh`); the
   * shell keeps the line the office assigned in `device.json`. A
   * function-typed property, unlike the methods above, because `useHostLink`
   * takes it unbound (`@typescript-eslint/unbound-method`).
   */
  refresh: () => Promise<DeviceStatus>;
  /** The installer's role for this computer (`install_role`). */
  installRole(): Promise<InstallRole>;
  /**
   * Reach the paired host at a new address (`https://host:port`) with the
   * same certificate (`device_change_address`); the pairing stays.
   */
  changeAddress(address: string): Promise<DeviceStatus>;
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
    async claim({ address, fingerprint, code, name, asNew }) {
      return parseStatus(
        await run("host_claim", {
          address,
          fingerprint,
          code,
          name,
          ...(asNew === true ? { asNew: true } : {}),
        }),
      );
    },
    async selectLine(lineId) {
      return parseStatus(await run("device_select_line", { lineId }));
    },
    async forget(options) {
      await run("device_forget", {
        ...(options?.keepUnsent === true ? { keepUnsent: true } : {}),
        ...(options?.repair === true ? { repair: true } : {}),
      });
    },
    async repairPending() {
      return (await run("device_repair_pending", {})) === true;
    },
    refresh: async () => parseStatus(await run("device_refresh", {})),
    async installRole() {
      const parsed = installRoleSchema.safeParse(await run("install_role", {}));
      if (!parsed.success) throw new DeviceError("invalid_response", parsed.error.message);
      return parsed.data;
    },
    async changeAddress(address) {
      return parseStatus(await run("device_change_address", { address }));
    },
  };
}

function parseStatus(raw: unknown): DeviceStatus {
  const parsed = deviceStatusSchema.safeParse(raw);
  if (!parsed.success) throw new DeviceError("invalid_response", parsed.error.message);
  return parsed.data;
}
