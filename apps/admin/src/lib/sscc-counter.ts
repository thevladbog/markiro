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
 * The caption under the counter field: what has been printed so far, what
 * saving will do, and the lowest value the server will accept.
 *
 * `minSerial` is one PAST the highest serial ever printed, so "printed
 * through" is `minSerial - 1` -- which is 0 (the box floor's `minSerial` is
 * 1) when nothing has been printed at all, and "Printed through 0" is not a
 * sentence anyone should read. That case gets its own key rather than an
 * interpolated zero. Shared by both counter forms so the two can never
 * disagree about when to use which.
 */
export function describeSsccNextLabelHint(t: TFunction, minSerial: number): string {
  return minSerial <= 1
    ? t("common.sscc.nextLabelHintNothingPrinted", { min: minSerial })
    : t("common.sscc.nextLabelHint", { printed: minSerial - 1, min: minSerial });
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
