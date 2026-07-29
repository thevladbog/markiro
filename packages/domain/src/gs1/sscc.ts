import { DomainError } from "../errors.js";
import { gs1CheckDigit, hasValidCheckDigit } from "./check-digit.js";

/** Serials available per prefix+extension: the serial field is 16 - |prefix| digits. */
export function ssccSerialCapacity(gs1Prefix: string): number {
  if (!/^\d{4,12}$/.test(gs1Prefix)) {
    throw new DomainError("SSCC_PREFIX", `bad GS1 prefix: "${gs1Prefix}"`);
  }
  return 10 ** (16 - gs1Prefix.length);
}

export function buildSscc(extensionDigit: number, gs1Prefix: string, serial: number): string {
  if (!Number.isInteger(extensionDigit) || extensionDigit < 0 || extensionDigit > 9) {
    throw new DomainError("SSCC_PREFIX", `bad extension digit: ${extensionDigit}`);
  }
  const capacity = ssccSerialCapacity(gs1Prefix); // throws SSCC_PREFIX on bad prefix
  if (!Number.isInteger(serial) || serial < 0 || serial >= capacity) {
    throw new DomainError("SSCC_RANGE", `serial ${serial} outside 0..${capacity - 1}`);
  }
  const body =
    String(extensionDigit) + gs1Prefix + String(serial).padStart(16 - gs1Prefix.length, "0");
  return body + String(gs1CheckDigit(body));
}

export function isValidSscc(code: string): boolean {
  return /^\d{18}$/.test(code) && hasValidCheckDigit(code);
}

/**
 * Extracts the bare 18-digit SSCC from what a scanner hands back.
 *
 * A GS1-128 encodes `00` + the 18 digits, and many scanners prepend the AIM
 * identifier `]C1`. Storage and transport carry the 18 digits alone, so this
 * is the one place that knows about the wrapper. Returns null rather than
 * throwing: a non-SSCC scan is an ordinary event here, not an error.
 */
export function parseScannedSscc(raw: string): string | null {
  let rest = raw.startsWith("]C1") ? raw.slice(3) : raw;
  if (rest.length === 20 && rest.startsWith("00")) rest = rest.slice(2);
  return isValidSscc(rest) ? rest : null;
}

/** The three fields `buildSscc` encodes into an SSCC's body, decoded back out. */
export interface ParsedSscc {
  extensionDigit: number;
  gs1Prefix: string;
  serial: number;
}

/**
 * Inverse of `buildSscc`: splits a valid 18-digit SSCC back into its
 * extension digit, GS1 prefix and serial. The prefix's length is not
 * recoverable from the SSCC itself -- the same way `buildSscc`/
 * `ssccSerialCapacity` must be told it -- so the caller passes it in.
 *
 * Returns null for anything `isValidSscc` rejects, matching
 * `parseScannedSscc`'s contract: a malformed or wrong-shaped input is an
 * ordinary event here, not an error.
 */
export function parseSscc(sscc: string, prefixLength: number): ParsedSscc | null {
  if (!isValidSscc(sscc)) return null;
  if (!Number.isInteger(prefixLength) || prefixLength < 4 || prefixLength > 12) {
    throw new DomainError("SSCC_PREFIX", `bad prefix length: ${prefixLength}`);
  }
  return {
    extensionDigit: Number(sscc[0]),
    gs1Prefix: sscc.slice(1, 1 + prefixLength),
    serial: Number(sscc.slice(1 + prefixLength, 17)),
  };
}
