import { classifyScan, validatePickupKm } from "@markiro/domain";

export type KioskScan =
  | { kind: "badge"; raw: string }
  /**
   * `serial` is carried, not re-derivable-by-convention: `validatePickupKm`
   * has already parsed it, and without it every consumer that wants to show a
   * worker *which* bottle this is would have to slice it back out of `kmKey`
   * and so would have to know that the key is laid out `01<gtin14>21<serial>`.
   * That layout is `@markiro/domain`'s business alone.
   */
  | { kind: "km"; rawKm: string; gtin14: string; serial: string; kmKey: string }
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
 *
 * When `not_km`, further distinguish product codes (GTIN, SSCC) from opaque
 * badge payloads by consulting `classifyScan`: GTINs and SSCCs are valid
 * logistics/product codes, not badges. A product barcode is NOT a badge
 * candidate, even if it fails KM parsing — the kiosk should report it as
 * an unknown code, not attempt badge resolution. Only structurally
 * unrecognized strings (opaque payloads with no valid GS1 form) become
 * badge candidates.
 */
export function classifyKioskScan(raw: string): KioskScan {
  const result = validatePickupKm(raw);
  switch (result.status) {
    case "ok":
      // Every field comes off the one parse `validatePickupKm` already did —
      // nothing here re-reads the raw payload.
      return {
        kind: "km",
        rawKm: raw,
        gtin14: result.km.gtin14,
        serial: result.km.serial,
        kmKey: result.key,
      };
    case "incomplete":
      // The GS separator (0x1D) was dropped — most likely a keyboard-wedge
      // scanner swallowing it. Never mis-parse this into a wrong serial /
      // dedup key: ask the screen to request a re-scan instead.
      return { kind: "incomplete", raw };
    case "not_km": {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return { kind: "unknown", raw };
      // Not a marking code at all (by structure). Further distinguish product
      // codes (GTIN, SSCC) from opaque badge payloads: product codes are valid
      // logistics codes and not badge candidates.
      const classified = classifyScan(raw);
      if (classified.kind === "gtin" || classified.kind === "sscc") {
        return { kind: "unknown", raw };
      }
      // Opaque payload — try badge resolution.
      return { kind: "badge", raw };
    }
  }
}
