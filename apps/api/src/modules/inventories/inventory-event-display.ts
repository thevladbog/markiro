import { canonicalizeKm, formatSsccHri, parseScannedSscc } from "@markiro/domain";

export type InventoryEventKind = "item" | "known_box" | "old_box";

/** The GS1 human-readable pair every cabinet list prints for a marking code. */
export function formatKmHri(gtin14: string, serial: string): string {
  return `(01)${gtin14} (21)${serial}`;
}

/**
 * The box form of the same identity. Never throws: one unusable SSCC must cost
 * its own row's readability, not the whole list.
 */
export function formatInventoryBoxIdentity(sscc: string, fallback: string): string {
  const parsed = parseScannedSscc(sscc);
  return parsed === null ? fallback : formatSsccHri(parsed);
}

/** Converts retained scan evidence into a readable, non-secret admin identity. */
export function formatInventoryEventIdentity(
  kind: InventoryEventKind,
  rawPayload: string | null,
  fallback: string,
): string {
  if (rawPayload === null) return fallback;

  if (kind === "item") {
    try {
      const km = canonicalizeKm(rawPayload);
      return formatKmHri(km.gtin14, km.serial);
    } catch {
      return fallback;
    }
  }

  return formatInventoryBoxIdentity(rawPayload, fallback);
}
