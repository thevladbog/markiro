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

/** One trailing AI/value pair from a KM, in the order it appears in the raw code. */
export interface KmAi {
  ai: string;
  value: string;
}

/** Ordered structural split of a raw Chestny ZNAK KM wire format. */
export interface KmSegments {
  gtin14: string;
  serial: string;
  /** Trailing AIs (91/92/93…) in encounter order (unlike `ParsedKm.ais`, which is keyed). */
  ais: KmAi[];
}

/**
 * Structurally splits a raw Chestny ZNAK KM (`01<gtin14>21<serial><GS>…`) into
 * its GS1 Application Identifier components, preserving AI encounter order.
 * Strips a leading `]d2` AIM symbology-identifier prefix, if present.
 *
 * This is the single shared parser of the KM wire format: `parseKm` (below)
 * layers GTIN check-digit validation on top and folds the ordered `ais` into
 * a lookup `Record`; `barcodes/svg.ts`'s DataMatrix renderer consumes the
 * ordered `ais` directly to rebuild a faithful GS1 element string for
 * whatever raw KM is already stored (no check-digit validation performed
 * here — that stays `parseKm`'s job on ingest).
 */
export function parseKmSegments(raw: string): KmSegments {
  if (raw.length === 0) throw new DomainError("KM_EMPTY", "empty scan");
  let s = raw.startsWith("]d2") ? raw.slice(3) : raw;
  if (!s.startsWith("01")) {
    throw new DomainError("KM_NO_GTIN", "KM must start with AI 01");
  }
  const gtin14 = s.slice(2, 16);
  s = s.slice(16);
  if (!s.startsWith("21")) {
    throw new DomainError("KM_NO_SERIAL", "KM must carry AI 21 serial");
  }
  const gsAt = s.indexOf(GS);
  const serial = gsAt === -1 ? s.slice(2) : s.slice(2, gsAt);
  if (serial.length === 0) {
    throw new DomainError("KM_NO_SERIAL", "KM serial is empty");
  }
  const ais: KmAi[] = [];
  let rest = gsAt === -1 ? "" : s.slice(gsAt + 1);
  while (rest.length > 0) {
    if (rest.startsWith(GS)) {
      rest = rest.slice(1);
      continue;
    }
    if (rest.length <= 2) break;
    const ai = rest.slice(0, 2);
    const end = rest.indexOf(GS);
    ais.push({ ai, value: end === -1 ? rest.slice(2) : rest.slice(2, end) });
    rest = end === -1 ? "" : rest.slice(end);
  }
  return { gtin14, serial, ais };
}

/**
 * Parses a Chestny ZNAK GS1 DataMatrix: `01<gtin14>21<serial><GS>…`.
 * Serial ends at the first GS or end of string. Remaining `<ai(2)><value>`
 * groups are collected verbatim into `ais`.
 */
export function parseKm(raw: string): ParsedKm {
  const segments = parseKmSegments(raw);
  const gtin14 = normalizeToGtin14(segments.gtin14); // throws GTIN_INVALID
  const ais: Record<string, string> = {};
  for (const { ai, value } of segments.ais) {
    ais[ai] = value;
  }
  return { gtin14, serial: segments.serial, raw, ais };
}

/** Canonical duplicate-detection identity of a KM. */
export function kmKey(km: ParsedKm): string {
  return `01${km.gtin14}21${km.serial}`;
}
