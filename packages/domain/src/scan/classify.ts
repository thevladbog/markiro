import { isValidGtin, normalizeToGtin14 } from "../gs1/gtin.js";
import { canonicalizeKm, type ParsedKm } from "../gs1/km.js";
import { parseScannedSscc } from "../gs1/sscc.js";

export type ScanInput =
  | { kind: "km"; km: ParsedKm }
  | { kind: "gtin"; gtin14: string }
  | { kind: "sscc"; sscc: string }
  | { kind: "unknown"; raw: string };

/** Single classification point for every scanner event. */
export function classifyScan(raw: string): ScanInput {
  const trimmed = raw.trim();
  const sscc = parseScannedSscc(trimmed);
  if (sscc) return { kind: "sscc", sscc };
  if (isValidGtin(trimmed)) {
    return { kind: "gtin", gtin14: normalizeToGtin14(trimmed) };
  }
  try {
    return { kind: "km", km: canonicalizeKm(raw) };
  } catch {
    return { kind: "unknown", raw };
  }
}
