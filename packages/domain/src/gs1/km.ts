import { DomainError } from "../errors.js";
import { normalizeToGtin14 } from "./gtin.js";

const GS = "\u001d";

export interface ParsedKm {
  gtin14: string;
  serial: string;
  raw: string;
  /** Trailing AIs (91/92/93…): AI → value, GS-separated in the raw code. */
  ais: Record<string, string>;
}

/**
 * Parses a Chestny ZNAK GS1 DataMatrix: `01<gtin14>21<serial><GS>…`.
 * Serial ends at the first GS or end of string. Remaining `<ai(2)><value>`
 * groups are collected verbatim into `ais`.
 */
export function parseKm(raw: string): ParsedKm {
  if (raw.length === 0) throw new DomainError("KM_EMPTY", "empty scan");
  let s = raw.startsWith("]d2") ? raw.slice(3) : raw;
  if (!s.startsWith("01")) {
    throw new DomainError("KM_NO_GTIN", "KM must start with AI 01");
  }
  const gtinDigits = s.slice(2, 16);
  const gtin14 = normalizeToGtin14(gtinDigits); // throws GTIN_INVALID
  s = s.slice(16);
  if (!s.startsWith("21") || s.length === 2) {
    throw new DomainError("KM_NO_SERIAL", "KM must carry AI 21 serial");
  }
  const gsAt = s.indexOf(GS);
  const serial = gsAt === -1 ? s.slice(2) : s.slice(2, gsAt);
  const ais: Record<string, string> = {};
  let rest = gsAt === -1 ? "" : s.slice(gsAt + 1);
  while (rest.length > 0) {
    if (rest.startsWith(GS)) {
      rest = rest.slice(1);
      continue;
    }
    if (rest.length <= 2) break;
    const ai = rest.slice(0, 2);
    const end = rest.indexOf(GS);
    ais[ai] = end === -1 ? rest.slice(2) : rest.slice(2, end);
    rest = end === -1 ? "" : rest.slice(end);
  }
  return { gtin14, serial, raw, ais };
}

/** Canonical duplicate-detection identity of a KM. */
export function kmKey(km: ParsedKm): string {
  return `01${km.gtin14}21${km.serial}`;
}
