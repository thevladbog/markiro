import { canonicalizeKm, kmHash, parseScannedSscc } from "@markiro/domain";

export type SearchClassification =
  { kind: "sscc"; sscc: string } | { kind: "km"; codeHash: string } | { kind: "unrecognized" };

/**
 * SSCC first (cheap, unambiguous, and a KM's own `canonicalizeKm` would
 * happily -- if wrongly -- accept a bare SSCC as a garbage-but-not-throwing
 * KM otherwise), then KM canonicalization; anything neither parses as is
 * `unrecognized`. Pure: no I/O, so it is unit-testable without a DB.
 */
export function classifySearchInput(q: string): SearchClassification {
  const trimmed = q.trim().replace(/^\(00\)\s*/, "(00)");
  const sscc = parseScannedSscc(trimmed.replace(/\s+/g, ""));
  if (sscc !== null) return { kind: "sscc", sscc };
  try {
    return { kind: "km", codeHash: kmHash(canonicalizeKm(q)) };
  } catch {
    return { kind: "unrecognized" };
  }
}
