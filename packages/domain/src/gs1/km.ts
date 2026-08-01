import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { DomainError } from "../errors.js";
import { normalizeToGtin14 } from "./gtin.js";

const GS = "\u001d";
export const MAX_KM_UTF8_BYTES = 1024;

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
  if (!/^\d{14}$/.test(gtin14)) {
    // Shape-only guard (not check-digit — that stays `parseKm`'s job). Fails
    // a malformed AI-01 here so the DataMatrix renderer / slip get a
    // DomainError instead of a raw bwip-js `GS1notNumeric`.
    throw new DomainError("KM_BAD_GTIN", "KM AI 01 GTIN must be 14 digits");
  }
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
  if (gsAt !== -1 && rest.length === 0) {
    throw new DomainError("KM_EMPTY_AI", "KM contains an empty trailing AI segment");
  }
  while (rest.length > 0) {
    if (rest.startsWith(GS)) {
      throw new DomainError("KM_EMPTY_AI", "KM contains an empty trailing AI segment");
    }
    if (rest.length <= 2) {
      throw new DomainError("KM_BAD_AI", "KM contains an incomplete trailing AI segment");
    }
    const ai = rest.slice(0, 2);
    if (!/^\d{2}$/.test(ai)) {
      throw new DomainError("KM_BAD_AI", "KM trailing AI must be two digits");
    }
    const end = rest.indexOf(GS);
    const value = end === -1 ? rest.slice(2) : rest.slice(2, end);
    if (value.length === 0) {
      throw new DomainError("KM_EMPTY_AI", `KM trailing AI ${ai} has an empty value`);
    }
    if (end === rest.length - 1) {
      throw new DomainError("KM_EMPTY_AI", "KM contains an empty trailing AI segment");
    }
    ais.push({ ai, value });
    rest = end === -1 ? "" : rest.slice(end + 1);
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
    if (Object.hasOwn(ais, ai)) {
      throw new DomainError("KM_DUPLICATE_AI", `KM contains duplicate trailing AI ${ai}`);
    }
    ais[ai] = value;
  }
  return { gtin14, serial: segments.serial, raw, ais };
}

/** Canonical duplicate-detection identity of a KM. */
export function kmKey(km: ParsedKm): string {
  return `01${km.gtin14}21${km.serial}`;
}

/** Stable storage/ownership identity; crypto tails are deliberately excluded. */
export function kmHash(km: ParsedKm): string {
  return bytesToHex(sha256(utf8ToBytes(kmKey(km))));
}

/**
 * Converts scanner text into the accepted/export representation. Acquisition
 * text remains a separate audit value; only a known AIM prefix and edge
 * transport whitespace are removed here.
 */
export function canonicalizeKm(raw: string): ParsedKm {
  let start = 0;
  let end = raw.length;
  while (start < end && (raw[start] === " " || raw[start] === "\t")) start += 1;
  while (end > start && (raw[end - 1] === " " || raw[end - 1] === "\t")) end -= 1;
  let canonicalRaw = raw.slice(start, end);
  if (canonicalRaw.startsWith("]d2")) canonicalRaw = canonicalRaw.slice(3);
  start = 0;
  end = canonicalRaw.length;
  while (start < end && (canonicalRaw[start] === " " || canonicalRaw[start] === "\t")) start += 1;
  while (end > start && (canonicalRaw[end - 1] === " " || canonicalRaw[end - 1] === "\t")) end -= 1;
  canonicalRaw = canonicalRaw.slice(start, end);

  if (canonicalRaw.includes("\ufffd")) {
    throw new DomainError("KM_BAD_ENCODING", "KM contains a replacement character");
  }
  for (let i = 0; i < canonicalRaw.length; i += 1) {
    const code = canonicalRaw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = canonicalRaw.charCodeAt(i + 1);
      if (i + 1 >= canonicalRaw.length || next < 0xdc00 || next > 0xdfff) {
        throw new DomainError("KM_BAD_ENCODING", "KM contains an unpaired UTF-16 surrogate");
      }
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new DomainError("KM_BAD_ENCODING", "KM contains an unpaired UTF-16 surrogate");
    }
    if ((code < 0x20 && code !== GS.charCodeAt(0)) || code === 0x7f) {
      throw new DomainError("KM_BAD_CONTROL", "KM contains a forbidden control character");
    }
  }
  const bytes = utf8ToBytes(canonicalRaw);
  if (bytes.length > MAX_KM_UTF8_BYTES) {
    throw new DomainError("KM_TOO_LONG", `KM exceeds the ${MAX_KM_UTF8_BYTES}-byte UTF-8 limit`);
  }

  return parseKm(canonicalRaw);
}
