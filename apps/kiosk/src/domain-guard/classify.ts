import { validatePickupKm } from "@markiro/domain";

export type KioskScan =
  | { kind: "badge"; raw: string }
  | { kind: "km"; rawKm: string; gtin14: string; kmKey: string }
  | { kind: "incomplete"; raw: string } // GS dropped — ask for a re-scan
  | { kind: "unknown"; raw: string };

/**
 * Turns a raw scan string from the kiosk's device (keyboard-wedge or
 * web-serial scanner) into a decision the screens can act on. All parsing
 * lives in `@markiro/domain` (`validatePickupKm`, itself built on
 * `classifyScan`/`parseKm`); this adapter only maps that result onto the
 * kiosk's outcome union — it never re-implements any GS1 parsing.
 *
 * Ordering matters: a scan is checked against the marking-code (KM) guard
 * FIRST, and only falls through to the opaque "badge" branch when
 * `validatePickupKm` says the payload is structurally not a KM at all
 * (`status: "not_km"`). Badge payloads carry no structure the kiosk can
 * verify — they are resolved locally against cached hashes and re-resolved
 * authoritatively by the server at submit — so a permissive badge branch
 * that ran before the KM check would happily swallow a malformed or
 * GS-dropped marking code. That would silently sign the worker in as
 * nobody instead of asking them to re-scan.
 */
export function classifyKioskScan(raw: string): KioskScan {
  const result = validatePickupKm(raw);
  switch (result.status) {
    case "ok":
      return { kind: "km", rawKm: raw, gtin14: result.km.gtin14, kmKey: result.key };
    case "incomplete":
      // The GS separator (0x1D) was dropped — most likely a keyboard-wedge
      // scanner swallowing it. Never mis-parse this into a wrong serial /
      // dedup key: ask the screen to request a re-scan instead.
      return { kind: "incomplete", raw };
    case "not_km": {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return { kind: "unknown", raw };
      // Not a marking code at all (by structure) — the only remaining
      // possibility the kiosk understands is an opaque badge payload.
      return { kind: "badge", raw };
    }
  }
}
