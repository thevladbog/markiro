/**
 * Shared shape, blocker/error wording and per-digit rules for the SSCC
 * counter forms (organisation settings and the counterparty panel). One rule,
 * one place -- two copies of this text would drift.
 *
 * SINCE 06d THERE IS MORE THAN ONE COUNTER. `GET /org/profile/sscc` and
 * `GET /counterparties/:id/sscc` return `{ counters: [...] }`, one entry per
 * extension digit (0 = boxes, 1 = pallets), because a pallet draws its SSCC
 * from its own numbering space. The list is keyed by `extensionDigit`, never
 * by array position, so a third space later only makes the list longer.
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

/** Mirrors `apps/api/src/modules/sscc/dto.ts`'s `SsccCounterListDto`. */
export interface SsccCounterListDto {
  counters: SsccCounterStateDto[];
}

/** `BOX_EXTENSION_DIGIT` / `PALLET_EXTENSION_DIGIT` in apps/api's sscc.service.ts. */
export const BOX_EXTENSION_DIGIT = 0;
export const PALLET_EXTENSION_DIGIT = 1;

/**
 * Which numbering space a digit names, for copy purposes. An unrecognised
 * digit is NOT collapsed into "boxes": a future numbering space must read as
 * itself rather than silently borrowing another one's nouns, so it gets the
 * neutral `other` wording with the digit spelled out.
 */
export type SsccCounterKind = "box" | "pallet" | "other";

export function ssccCounterKind(extensionDigit: number): SsccCounterKind {
  if (extensionDigit === BOX_EXTENSION_DIGIT) return "box";
  if (extensionDigit === PALLET_EXTENSION_DIGIT) return "pallet";
  return "other";
}

/**
 * The lowest serial this digit's counter can ever hold, mirroring
 * `sscc.service.ts`'s `const firstSerial = extensionDigit === 0 ? 1 : 0`.
 * Boxes start at 1; every other space may legitimately sit at 0, and a form
 * that clamped it to 1 would show a value the server never returned.
 */
export function ssccFirstSerial(extensionDigit: number): number {
  return extensionDigit === BOX_EXTENSION_DIGIT ? 1 : 0;
}

/**
 * Titles the counter's own section ("Короба"/"Паллеты"), so two counters on
 * one page are told apart by name rather than by position.
 */
export function ssccCounterTitle(t: TFunction, extensionDigit: number): string {
  const kind = ssccCounterKind(extensionDigit);
  return kind === "other"
    ? t("common.sscc.kind.other.title", { digit: extensionDigit })
    : t(`common.sscc.kind.${kind}.title`);
}

/** Accessible label for the counter's serial field -- distinct per counter, as two fields need. */
export function ssccNextSerialLabel(t: TFunction, extensionDigit: number): string {
  const kind = ssccCounterKind(extensionDigit);
  return kind === "other"
    ? t("common.sscc.kind.other.nextSerialLabel", { digit: extensionDigit })
    : t(`common.sscc.kind.${kind}.nextSerialLabel`);
}

/** Accessible label for the counter's save button -- likewise distinct per counter. */
export function ssccSaveLabel(t: TFunction, extensionDigit: number): string {
  const kind = ssccCounterKind(extensionDigit);
  return kind === "other"
    ? t("common.sscc.kind.other.save", { digit: extensionDigit })
    : t(`common.sscc.kind.${kind}.save`);
}

/**
 * The sentence explaining why this counter is locked, or null when it isn't.
 * Shared by the organisation settings card and the counterparty panel: the
 * rule is one rule, and two copies of this text would drift.
 *
 * Note the blocker is per digit, not per tenant: `findSeedBlocker` scopes its
 * out-of-sync-device search to the digit's own `sscc_blocks`, so a station
 * holding a live box block but no pallet block blocks ONLY the box counter.
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
 * through" is `minSerial - 1` -- which is this digit's own `firstSerial - 1`
 * when nothing has been printed at all, and "Printed through 0" is not a
 * sentence anyone should read. That case gets its own key rather than an
 * interpolated zero. The floor differs per digit (boxes start at 1, pallets
 * at 0), which is why the digit, not a hard-coded 1, decides which key wins.
 */
export function describeSsccNextLabelHint(
  t: TFunction,
  counter: Pick<SsccCounterStateDto, "extensionDigit" | "minSerial">,
): string {
  return counter.minSerial <= ssccFirstSerial(counter.extensionDigit)
    ? t("common.sscc.nextLabelHintNothingPrinted", { min: counter.minSerial })
    : t("common.sscc.nextLabelHint", { printed: counter.minSerial - 1, min: counter.minSerial });
}

/**
 * A save rejection, as a localized sentence. The server's own message is
 * English-only prose meant for logs; what reaches the operator is keyed off
 * the machine-readable `code` instead. Anything unrecognised falls back to
 * the caller's generic error text.
 *
 * `belowFloor` names the physical thing already printed under this digit --
 * boxes or pallets -- because "lower ones are already printed on boxes" is
 * simply false when the rejected counter is the pallet one.
 */
export function describeSsccSeedError(
  t: TFunction,
  error: unknown,
  counter: Pick<SsccCounterStateDto, "extensionDigit" | "minSerial">,
): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  switch (error.code) {
    case "sscc_seed_below_floor": {
      const kind = ssccCounterKind(counter.extensionDigit);
      return kind === "other"
        ? t("common.sscc.errors.belowFloorOther", { min: counter.minSerial })
        : t(`common.sscc.errors.belowFloor.${kind}`, { min: counter.minSerial });
    }
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
