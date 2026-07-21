import { DomainError } from "../errors.js";
import { gs1CheckDigit, hasValidCheckDigit } from "./check-digit.js";

/** Serials available per prefix+extension: the serial field is 16 - |prefix| digits. */
export function ssccSerialCapacity(gs1Prefix: string): number {
  return 10 ** (16 - gs1Prefix.length);
}

export function buildSscc(
  extensionDigit: number,
  gs1Prefix: string,
  serial: number,
): string {
  if (
    !Number.isInteger(extensionDigit) || extensionDigit < 0 || extensionDigit > 9 ||
    !/^\d{4,12}$/.test(gs1Prefix)
  ) {
    throw new DomainError("SSCC_PREFIX", `bad extension/prefix: ${extensionDigit}/"${gs1Prefix}"`);
  }
  const capacity = ssccSerialCapacity(gs1Prefix);
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
