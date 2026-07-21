import { DomainError } from "../errors.js";
import { hasValidCheckDigit } from "./check-digit.js";

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/** Zero-pads GTIN-8/12/13/14 to GTIN-14 and verifies the check digit. */
export function normalizeToGtin14(input: string): string {
  if (!/^\d+$/.test(input) || !GTIN_LENGTHS.has(input.length)) {
    throw new DomainError("GTIN_INVALID", `not a GTIN: "${input}"`);
  }
  if (!hasValidCheckDigit(input)) {
    throw new DomainError("GTIN_INVALID", `check digit mismatch: "${input}"`);
  }
  return input.padStart(14, "0");
}

export function isValidGtin(input: string): boolean {
  try {
    normalizeToGtin14(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Owner detection for tolling: strip the GTIN-14 indicator digit and test
 * whether the remaining body starts with the GS1 company prefix.
 */
export function gtinMatchesPrefix(gtin14: string, gs1Prefix: string): boolean {
  if (gtin14.length !== 14 || !/^\d+$/.test(gs1Prefix) || gs1Prefix.length === 0) {
    return false;
  }
  return gtin14.slice(1).startsWith(gs1Prefix);
}
