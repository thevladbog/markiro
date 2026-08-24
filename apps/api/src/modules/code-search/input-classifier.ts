import { canonicalizeKm, kmHash, parseScannedSscc } from "@markiro/domain";

export type SearchClassification =
  | { kind: "sscc"; sscc: string }
  | { kind: "km"; codeHash: string }
  | { kind: "partial-sscc"; digits: string }
  | { kind: "unrecognized" };

/**
 * SSCC first (cheap, unambiguous, and a KM's own `canonicalizeKm` would
 * happily -- if wrongly -- accept a bare SSCC as a garbage-but-not-throwing
 * KM otherwise), then a digits-only fragment as a partial SSCC (a manager
 * often has just the tail of the box number off a label), then KM
 * canonicalization; anything neither parses as is `unrecognized`. Pure: no
 * I/O, so it is unit-testable without a DB.
 *
 * The partial branch is safe to check before KM: the shortest well-formed
 * KM (`01` + 14-digit GTIN + `21` + 1-char serial) is 19 characters, so a
 * pure-digit string of 4..18 characters can never be a complete KM. 4 is
 * the floor so a stray 1-3 digit typo does not fan out into a substring
 * scan over every box.
 */
export function classifySearchInput(q: string): SearchClassification {
  const trimmed = q.trim().replace(/^\(00\)\s*/, "(00)");
  const compact = trimmed.replace(/\s+/g, "");
  const sscc = parseScannedSscc(compact);
  if (sscc !== null) return { kind: "sscc", sscc };
  if (/^\d{4,18}$/.test(compact)) return { kind: "partial-sscc", digits: compact };
  try {
    return { kind: "km", codeHash: kmHash(canonicalizeKm(q)) };
  } catch {
    return { kind: "unrecognized" };
  }
}
