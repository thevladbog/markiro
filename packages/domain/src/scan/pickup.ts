import { kmKey, type ParsedKm } from "../gs1/km.js";
import { classifyScan } from "./classify.js";

export type PickupKmResult =
  | { status: "ok"; km: ParsedKm; key: string }
  | { status: "not_km"; raw: string }
  | { status: "incomplete"; raw: string; reason: string };

/**
 * Guards a scan intended to be a Chestny ZNAK product KM before it enters a
 * pickup order. Unlike parseKm(), this rejects a KM whose GS separator was
 * dropped by a keyboard-wedge scanner: such a scan folds the crypto tail into
 * the serial (no trailing AI 91/92/93), which would corrupt the dedup key.
 */
export function validatePickupKm(
  raw: string,
  opts: { requireCryptoTail?: boolean } = {},
): PickupKmResult {
  const requireCryptoTail = opts.requireCryptoTail ?? true;
  const scan = classifyScan(raw);
  if (scan.kind !== "km") return { status: "not_km", raw };
  const km = scan.km;
  if (requireCryptoTail && Object.keys(km.ais).length === 0) {
    return {
      status: "incomplete",
      raw,
      reason: "no trailing AI (91/92/93) — GS separator likely dropped by the scanner",
    };
  }
  return { status: "ok", km, key: kmKey(km) };
}
