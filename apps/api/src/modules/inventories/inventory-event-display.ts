import { canonicalizeKm, formatSsccHri, parseScannedSscc } from "@markiro/domain";

export type InventoryEventKind = "item" | "known_box" | "old_box";

/** Returns a validated canonical identity suitable for clipboard use. */
export function formatInventoryEventCopyIdentity(
  kind: InventoryEventKind,
  rawPayload: string | null,
): string | null {
  if (rawPayload === null) return null;

  if (kind === "item") {
    try {
      return canonicalizeKm(rawPayload).raw;
    } catch {
      return null;
    }
  }

  const sscc = parseScannedSscc(rawPayload);
  return sscc === null ? null : `00${sscc}`;
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
      return `(01)${km.gtin14} (21)${km.serial}`;
    } catch {
      return fallback;
    }
  }

  const sscc = parseScannedSscc(rawPayload);
  return sscc === null ? fallback : formatSsccHri(sscc);
}
