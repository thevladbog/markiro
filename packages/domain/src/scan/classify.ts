import { isValidGtin, normalizeToGtin14 } from "../gs1/gtin.js";
import { parseKm, type ParsedKm } from "../gs1/km.js";
import { isValidSscc } from "../gs1/sscc.js";

export type ScanInput =
  | { kind: "km"; km: ParsedKm }
  | { kind: "gtin"; gtin14: string }
  | { kind: "sscc"; sscc: string }
  | { kind: "unknown"; raw: string };

/** Single classification point for every scanner event. */
export function classifyScan(raw: string): ScanInput {
  const trimmed = raw.trim();
  if (isValidSscc(trimmed)) return { kind: "sscc", sscc: trimmed };
  if (trimmed.startsWith("00") && isValidSscc(trimmed.slice(2))) {
    return { kind: "sscc", sscc: trimmed.slice(2) };
  }
  if (isValidGtin(trimmed)) {
    return { kind: "gtin", gtin14: normalizeToGtin14(trimmed) };
  }
  try {
    return { kind: "km", km: parseKm(trimmed) };
  } catch {
    return { kind: "unknown", raw };
  }
}
