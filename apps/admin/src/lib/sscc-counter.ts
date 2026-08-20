/**
 * Shared blocker/error wording for the SSCC counter forms (organisation
 * settings and the counterparty panel). One rule, one place -- two copies of
 * this text would drift.
 */
import type { TFunction } from "i18next";

import { ApiRequestError } from "../api/client.js";

/** Mirrors `apps/api/src/modules/sscc/dto.ts`'s `SsccSeedBlocker`. */
export type SsccSeedBlocker =
  | { kind: "active_shift"; shiftId: string; shiftNumber: string }
  | { kind: "device_out_of_sync"; deviceId: string; deviceName: string };

/** Mirrors `apps/api/src/modules/sscc/dto.ts`'s `SsccCounterStateDto`. */
export interface SsccCounterStateDto {
  extensionDigit: number;
  nextSerial: number;
  minSerial: number;
  blockedBy: SsccSeedBlocker | null;
}

/**
 * The sentence explaining why the counter is locked, or null when it isn't.
 * Shared by the organisation settings card and the counterparty panel: the
 * rule is one rule, and two copies of this text would drift.
 */
export function describeSsccBlocker(
  t: TFunction,
  blockedBy: SsccSeedBlocker | null,
): string | null {
  if (!blockedBy) return null;
  return blockedBy.kind === "active_shift"
    ? t("common.sscc.blocked.activeShift", { number: blockedBy.shiftNumber })
    : t("common.sscc.blocked.deviceOutOfSync", { device: blockedBy.deviceName });
}

/**
 * A save rejection, as a localized sentence. The server's own message is
 * English-only prose meant for logs; what reaches the operator is keyed off
 * the machine-readable `code` instead. Anything unrecognised falls back to
 * the caller's generic error text.
 */
export function describeSsccSeedError(
  t: TFunction,
  error: unknown,
  minSerial: number,
): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  switch (error.code) {
    case "sscc_seed_below_floor":
      return t("common.sscc.errors.belowFloor", { min: minSerial });
    case "sscc_seed_floor_moved":
      return t("common.sscc.errors.floorMoved");
    case "sscc_seed_active_shift":
      return t("common.sscc.errors.activeShift");
    case "sscc_seed_device_out_of_sync":
      return t("common.sscc.errors.deviceOutOfSync");
    default:
      return null;
  }
}
